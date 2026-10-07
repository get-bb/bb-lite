//! The connect plugin (`plugins/connect/test/server.test.ts`) against the fake gate.

mod native_connect_support;

use std::sync::atomic::Ordering;

use bb_connect::share_url;
use bb_server::plugins::api::{CliResult, MachineAccess, RpcErrorCode};
use indexmap::IndexMap;
use native_connect_support::harness;
use serde_json::{Value, json};

fn ok(stdout: &str) -> CliResult {
    CliResult { exit_code: 0, stdout: format!("{stdout}\n"), stderr: String::new() }
}

fn failed(message: &str) -> CliResult {
    CliResult { exit_code: 1, stdout: String::new(), stderr: format!("{message}\n") }
}

const INSTRUCTIONS: &str = "The user can reach this bb remotely at {url}. When you start an HTTP \
     server they should see, run `bb connect expose <port>` and give them the URL it prints as a \
     markdown link; a localhost URL does not open remotely.";

#[tokio::test]
async fn unlinked_bb_signs_in_with_the_device_flow() {
    let h = harness(false).await;
    let status = h.status().await;
    assert_eq!(
        status,
        json!({
            "state": "disconnected", "paired": false, "enabled": true, "handle": null,
            "url": null, "lastError": null, "nextRetryAt": null, "login": null, "shares": [],
        })
    );
    assert_eq!(h.cli(&["status"]).await, ok("Not signed in. Run `bb connect login`."));
    assert_eq!(h.host.public_url(), None);
    assert_eq!(h.host.instructions_for(&h.context("thr_1", None)).await, "");
    let not_paired = "this bb isn't signed in; run `bb connect login` first";
    assert_eq!(h.cli(&["expose", "8080"]).await, failed(not_paired));

    let verification = format!("{}/link", h.gate.apex_url);
    let started = h.cli(&["login"]).await;
    assert_eq!(started, ok(&format!("Confirm the code BEE-123 at {verification}")));
    let linked = h.wait_for(|s| s["paired"] == true && s["state"] == "connected").await;
    assert_eq!(linked["handle"], "bee");
    let url = linked["url"].as_str().unwrap().to_owned();
    assert!(url.starts_with(&h.gate.gate_url), "{url}");
    assert_eq!(h.host.public_url(), Some(url.clone()));
    let instructions = h.host.instructions_for(&h.context("thr_1", None)).await;
    assert_eq!(instructions, INSTRUCTIONS.replace("{url}", &url));
    h.host.stop().await;
}

#[tokio::test]
async fn linked_bb_reports_publishes_and_toggles_remote_access() {
    let h = harness(true).await;
    let status = h.connected().await;
    let gate_url = h.gate.gate_url.clone();
    assert_eq!(status["url"], json!(gate_url));
    assert_eq!(h.host.public_url(), Some(gate_url.clone()));
    assert_eq!(h.cli(&["status"]).await, ok(&format!("bee  {gate_url}  connected")));
    let json = h.cli(&["status", "--json"]).await;
    let reported: Value = serde_json::from_str(&json.stdout).unwrap();
    assert_eq!(json.stdout, format!("{}\n", serde_json::to_string_pretty(&reported).unwrap()));
    assert_eq!(reported["handle"], "bee");
    assert_eq!(reported["state"], "connected");

    assert_eq!(h.cli(&["off"]).await, ok(&format!("bee  {gate_url}  off")));
    assert_eq!(h.host.public_url(), None);
    assert_eq!(h.host.instructions_for(&h.context("thr_1", None)).await, "");
    let off = h.wait_for(|s| s["state"] == "disconnected").await;
    assert_eq!(off["enabled"], false);
    let on = h.rpc("setEnabled", json!({ "enabled": true })).await.unwrap();
    assert_eq!(on["enabled"], true);
    assert_eq!(h.host.public_url(), Some(gate_url.clone()));
    h.connected().await;

    let invalid = h.rpc("setEnabled", json!({ "enabled": "yes" })).await.unwrap_err();
    assert_eq!(invalid.code, RpcErrorCode::InvalidInput);
    let invalid = h.rpc("status", json!({})).await.unwrap_err();
    assert_eq!(invalid.code, RpcErrorCode::InvalidInput);

    assert_eq!(h.cli(&["logout"]).await, ok("Not signed in. Run `bb connect login`."));
    assert_eq!(h.gate.disconnects.load(Ordering::SeqCst), 1);
    assert_eq!(h.host.public_url(), None);
    assert!(!h.temp.path().join("data/connect.json").exists());
    let status = h.status().await;
    assert_eq!(
        (status["paired"].clone(), status["state"].clone()),
        (json!(false), json!("disconnected"))
    );
    h.host.stop().await;
}

#[tokio::test]
async fn ports_are_exposed_listed_and_unexposed() {
    let h = harness(true).await;
    h.connected().await;
    let link = h.gate.link();
    let (first, second) = (share_url(&link, 8080), share_url(&link, 3000));
    h.realtime.signals();
    assert_eq!(h.cli(&["expose", "8080"]).await, ok(&first));
    let signals = h.realtime.signals();
    let signal = json!({
        "type": "plugin-signal", "pluginId": "connect", "channel": "status", "payload": null,
    });
    assert_eq!(signals, vec![signal]);
    let exposed = h.cli(&["expose", "3000", "--json"]).await;
    let pretty = serde_json::to_string_pretty(&json!({ "port": 3000, "url": second })).unwrap();
    assert_eq!(exposed, ok(&pretty));
    let gate_url = &h.gate.gate_url;
    let listing = format!("bee  {gate_url}  connected\n  3000  {second}\n  8080  {first}");
    assert_eq!(h.cli(&["shares"]).await, ok(&listing));
    assert_eq!(h.cli(&["status"]).await, ok(&listing));
    let shares = json!([{ "port": 3000, "url": second }, { "port": 8080, "url": first }]);
    let listed = h.cli(&["shares", "--json"]).await;
    assert_eq!(listed, ok(&serde_json::to_string_pretty(&shares).unwrap()));
    assert_eq!(h.status().await["shares"], shares);

    let invalid = "Cannot share port 70000: expected a TCP port other than bb's own";
    assert_eq!(h.cli(&["expose", "70000"]).await, failed(invalid));
    let invalid = "Cannot share port NaN: expected a TCP port other than bb's own";
    assert_eq!(h.cli(&["expose", "web"]).await, failed(invalid));

    assert_eq!(h.cli(&["unexpose", "8080"]).await, ok("Revoked 1 shared ports."));
    let removed = h.cli(&["unexpose", "8080", "--json"]).await;
    assert_eq!(removed, ok(&serde_json::to_string_pretty(&json!({ "removed": 0 })).unwrap()));
    let after = h.rpc("unexpose", json!({ "port": 3000 })).await.unwrap();
    assert_eq!(after["shares"], json!([]));
    assert_eq!(h.cli(&["expose", "9000"]).await, ok(&share_url(&link, 9000)));
    assert_eq!(h.cli(&["expose", "9001"]).await, ok(&share_url(&link, 9001)));
    assert_eq!(h.cli(&["unexpose-all"]).await, ok("Revoked 2 shared ports."));
    let bad = h.rpc("unexpose", json!({ "port": "80" })).await.unwrap_err();
    assert_eq!(bad.code, RpcErrorCode::InvalidInput);

    // Shares persist in the plugin's kv across a restart.
    assert_eq!(h.cli(&["expose", "4000"]).await, ok(&share_url(&link, 4000)));
    h.host.reload(Some("connect")).await.unwrap();
    assert_eq!(
        h.status().await["shares"],
        json!([{ "port": 4000, "url": share_url(&link, 4000) }])
    );
    h.host.stop().await;
}

#[tokio::test]
async fn machine_access_mints_and_revokes_machine_credentials() {
    let h = harness(true).await;
    h.connected().await;
    let provider = h.host.machine_access().unwrap();
    let granted = provider.grant("laptop").await.unwrap();
    let headers = IndexMap::from([("x-bb-connect-machine".to_owned(), "bbcm_1".to_owned())]);
    let expected = MachineAccess { server_url: h.gate.gate_url.clone(), headers };
    assert_eq!(granted, Some(expected.clone()));
    assert_eq!(provider.grant("laptop").await.unwrap(), Some(expected));
    assert_eq!(h.gate.machines.lock().get("bbcm_1").map(String::as_str), Some("machine_1"));

    provider.revoke("laptop", Some("machine_7")).await.unwrap();
    assert_eq!(*h.gate.revoked.lock(), vec!["machine_1".to_owned(), "machine_7".to_owned()]);
    assert!(h.gate.machines.lock().is_empty());
    provider.revoke("laptop", None).await.unwrap();
    assert_eq!(h.gate.revoked.lock().len(), 2);
    let regranted = provider.grant("laptop").await.unwrap().unwrap();
    assert_eq!(regranted.headers["x-bb-connect-machine"], "bbcm_2");

    h.cli(&["off"]).await;
    assert_eq!(provider.grant("laptop").await.unwrap(), None);
    h.host.stop().await;
}

#[tokio::test]
async fn instructions_and_ports_are_for_threads_on_the_server_machine() {
    let h = harness(true).await;
    h.connected().await;
    let local = h.host.instructions_for(&h.context("thr_1", Some("local"))).await;
    assert_eq!(local, INSTRUCTIONS.replace("{url}", &h.gate.gate_url));
    assert_eq!(h.host.instructions_for(&h.context("thr_2", Some("laptop"))).await, "");
    let remote = "This thread runs on another machine. bb connect only shares ports of the \
                  machine that runs the bb server.";
    assert_eq!(h.cli_in(Some("thr_2"), &["expose", "8080"]).await, failed(remote));
    let shared = h.cli_in(Some("thr_1"), &["expose", "8080"]).await;
    assert_eq!(shared, ok(&share_url(&h.gate.link(), 8080)));
    h.host.stop().await;
}

#[tokio::test]
async fn cli_lists_commands_and_guards_legacy_import() {
    let h = harness(false).await;
    let cli = h.host.running("connect").unwrap().cli().unwrap();
    assert_eq!(cli.name(), "connect");
    assert_eq!(cli.summary(), "Reach this bb at its getbb.app address and share local ports");
    let names = cli.commands().into_iter().map(|c| c.name).collect::<Vec<_>>();
    let expected = [
        "login",
        "status",
        "logout",
        "on",
        "off",
        "expose",
        "unexpose",
        "unexpose-all",
        "shares",
        "import-legacy",
    ];
    assert_eq!(names, expected);
    let warning = "STOP THE ORIGINAL bb SERVER FIRST. getbb.app allows one tunnel per server \
                   label: while the original server runs, this one and that one keep \
                   disconnecting each other and every machine with them.";
    let refused = h.cli(&["import-legacy", "--db", "old.db"]).await;
    let hint = "Re-run with --yes once it is stopped.";
    assert_eq!(refused, failed(&format!("{warning}\n\n{hint}")));
    let refused = h.cli(&["import-legacy", "--db", "old.db", "--json"]).await;
    let body: Value = serde_json::from_str(&refused.stdout).unwrap();
    assert_eq!(body["error"]["code"], "confirmation_required");
    let help = h.cli(&["expose", "--help"]).await;
    assert!(help.stdout.contains("Share a port of the server machine"), "{}", help.stdout);
    assert!(help.stdout.contains("TCP port on the server machine"), "{}", help.stdout);
    h.host.stop().await;
}
