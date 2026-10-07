//! A visitor's request travelling fake gate → tunnel → the full Rust HTTP app, as
//! plugins/connect/test/server.test.ts does.

mod native_connect_support;

use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

use bb_server::config::{ServerEnv, load_config};
use bb_server::plugins::builtin::{BuiltinPlugin, BuiltinServer, builtin_plugins};
use bb_server::plugins::native::connect::ConnectPlugin;
use bb_server::runners::local::{LocalRunnerHandle, local_runner_for};
use bb_server::server::{BbServer, CreateServerOptions, create_server};
use futures::{SinkExt, StreamExt};
use native_connect_support::{FakeGate, start_fake_gate};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const OWNER: (&str, &str) = ("cookie", "session=owner");
const JSON_BODY: (&str, &str) = ("content-type", "application/json");

struct Booted {
    server: BbServer,
    gate: Arc<FakeGate>,
    _local: LocalRunnerHandle,
    _dirs: TempDir,
}

struct Visit {
    status: u16,
    text: String,
    chunked: bool,
    coding: Option<String>,
}

/// A free loopback port: the connect plugin replays tunnelled requests against the server's
/// configured port, which server.test.ts sets after listening.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

async fn cli(url: &str, argv: &[&str]) -> Value {
    let body = json!({ "argv": argv, "cwd": std::env::temp_dir(), "threadId": "thr_1" });
    let response = reqwest::Client::new()
        .post(format!("{url}/api/v1/plugins/connect/cli"))
        .json(&body)
        .send()
        .await
        .unwrap();
    response.json().await.unwrap()
}

async fn status(url: &str) -> Value {
    let reply = cli(url, &["status", "--json"]).await;
    serde_json::from_str(reply["stdout"].as_str().unwrap_or("null")).unwrap_or(Value::Null)
}

/// A real server whose connect builtin talks to a fresh fake gate, signed in through the device
/// flow and connected.
async fn start_server() -> Booted {
    let gate = start_fake_gate().await;
    let dirs = tempfile::tempdir().unwrap();
    let path = |name: &str| dirs.path().join(name).to_string_lossy().into_owned();
    std::fs::create_dir_all(path("app")).unwrap();
    std::fs::write(dirs.path().join("app/index.html"), "<!doctype html>").unwrap();
    let env: ServerEnv = [
        ("BB_DATA_DIR", path("data")),
        ("BB_SERVER_PORT", free_port().to_string()),
        ("BB_SERVER_BIND_HOST", "127.0.0.1".to_owned()),
        ("BB_APP_DIR", path("app")),
        ("BB_LOG_LEVEL", "silent".to_owned()),
        ("CODEX_HOME", path("codex")),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value))
    .collect();
    let config = load_config(&env).unwrap();
    let (runner, local) = local_runner_for(&config, Vec::new());
    let entry = builtin_plugins().into_iter().find(|p| p.directory.ends_with("connect")).unwrap();
    let connect = Arc::new(ConnectPlugin::with_base_url(gate.apex_url.clone()));
    let builtin =
        BuiltinPlugin { directory: entry.directory, server: BuiltinServer::Native(connect) };
    let mut options = CreateServerOptions::new(config, runner);
    options.builtins = Some(vec![builtin]);
    let server = create_server(options).unwrap();
    let url = server.listen().await.unwrap().url;

    let started = cli(&url, &["login"]).await;
    assert_eq!(started["exitCode"], 0, "{started}");
    for _ in 0..1000 {
        if status(&url).await["state"] == "connected" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(status(&url).await["state"], "connected");
    Booted { server, gate, _local: local, _dirs: dirs }
}

/// A request sent to the gate's visitor entry, as `visit` in fake-gate.ts.
async fn visit(
    gate: &FakeGate,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> Visit {
    let method = reqwest::Method::from_bytes(method.as_bytes()).unwrap();
    let mut request = reqwest::Client::new().request(method, format!("{}{path}", gate.gate_url));
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    if let Some(body) = body {
        request = request.body(body.to_owned());
    }
    let response = request.send().await.unwrap();
    let status = response.status().as_u16();
    let header = |name: &str| response.headers().get(name).and_then(|v| v.to_str().ok());
    let chunked = header("transfer-encoding") == Some("chunked");
    let coding = header("content-encoding").map(str::to_owned);
    let raw = response.bytes().await.unwrap();
    let text = if coding.as_deref() == Some("gzip") {
        let mut text = String::new();
        flate2::read::GzDecoder::new(&raw[..]).read_to_string(&mut text).unwrap();
        text
    } else {
        String::from_utf8_lossy(&raw).into_owned()
    };
    Visit { status, text, chunked, coding }
}

/// The status and error code of a visit.
async fn code(
    gate: &FakeGate,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> (u16, Option<String>) {
    let visited = visit(gate, method, path, headers, body).await;
    let body: Value =
        serde_json::from_str(if visited.text.is_empty() { "{}" } else { &visited.text })
            .unwrap_or(Value::Null);
    (visited.status, body["code"].as_str().map(str::to_owned))
}

/// The next message on a realtime socket that satisfies `wanted`.
async fn next<S>(socket: &mut S, wanted: impl Fn(&Value) -> bool) -> Value
where
    S: futures::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let read = async {
        loop {
            let message = socket.next().await.unwrap().unwrap();
            let Message::Text(text) = message else { continue };
            let message: Value = serde_json::from_str(&text).unwrap();
            if wanted(&message) {
                return message;
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(10), read).await.expect("no matching message")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn serves_gate_authenticated_visitors_through_the_tunnel() {
    let Booted { server, gate, _local, _dirs } = start_server().await;
    let ctx = server.ctx.clone();
    assert_eq!(ctx.plugins.public_url().as_deref(), Some(gate.gate_url.as_str()));
    let host_id = ctx.config.host_id.clone();
    let host_path = format!("/api/v1/hosts/{host_id}");
    let origin = ("origin", gate.gate_url.as_str());
    let owner_json = [OWNER, JSON_BODY, origin];

    let listed = visit(&gate, "GET", "/api/v1/hosts", &[OWNER], None).await;
    let listed: Value = serde_json::from_str(&listed.text).unwrap();
    assert_eq!(listed.as_array().map(Vec::len), Some(1), "{listed}");
    assert_eq!(listed[0]["id"], host_id.as_str(), "{listed}");

    let zipped = [OWNER, ("accept-encoding", "gzip")];
    let config = visit(&gate, "GET", "/api/v1/system/config", &zipped, None).await;
    let primary: Value = serde_json::from_str(&config.text).unwrap();
    assert_eq!(
        (config.coding.as_deref(), primary["primaryHostId"].as_str()),
        (Some("gzip"), Some(host_id.as_str()))
    );

    let body = json!({ "argv": ["status", "--json"] }).to_string();
    let ran = visit(&gate, "POST", "/api/v1/plugins/connect/cli", &owner_json, Some(&body)).await;
    assert_eq!((ran.status, ran.chunked), (200, true), "{}", ran.text);
    let ran: Value = serde_json::from_str(&ran.text).unwrap();
    let reported: Value = serde_json::from_str(ran["stdout"].as_str().unwrap()).unwrap();
    assert_eq!(reported["state"], "connected", "{reported}");
    assert_eq!(reported["url"], gate.gate_url.as_str(), "{reported}");
    assert_eq!(reported["handle"], "bee", "{reported}");

    gate.machines.lock().insert("bbcm_laptop".into(), "machine_9".into());
    let forged = [("x-bb-gate-auth", "session"), ("x-bb-via-tunnel", "0")];
    let machine = [("x-bb-connect-machine", "bbcm_laptop"), forged[0], forged[1]];
    let as_machine = [machine[0], machine[1], machine[2], JSON_BODY];
    let manual = json!({ "machineProviderId": "manual", "inputs": null }).to_string();
    let command = format!("{host_path}/enrollment-command");
    assert_eq!(code(&gate, "GET", &command, &[OWNER], None).await.0, 200);
    assert_eq!(code(&gate, "GET", "/api/v1/hosts", &machine, None).await.0, 200);
    let forbidden = (403, Some("forbidden".to_owned()));
    assert_eq!(code(&gate, "GET", &command, &machine, None).await, forbidden);
    let added = code(&gate, "POST", "/api/v1/hosts", &as_machine, Some(&manual)).await;
    assert_eq!(added, forbidden);
    assert_eq!(code(&gate, "DELETE", &host_path, &machine, None).await, forbidden);
    let anonymous = code(&gate, "GET", "/install.sh", &forged, None).await;
    assert_eq!(anonymous, (404, Some("not_found".to_owned())));
    assert_eq!(code(&gate, "GET", "/api/v1/hosts", &[], None).await, (401, None));

    let live = format!("{}/ws", gate.gate_url.replacen("http", "ws", 1));
    let mut request = live.into_client_request().unwrap();
    request.headers_mut().insert(OWNER.0, OWNER.1.parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let subscribe = json!({ "type": "subscribe", "target": { "kind": "host-list" } });
    socket.send(Message::text(subscribe.to_string())).await.unwrap();
    socket.send(Message::text(json!({ "type": "ping" }).to_string())).await.unwrap();
    next(&mut socket, |message| message["type"] == "pong").await;
    let rename = json!({ "name": "hive" }).to_string();
    let renamed = code(&gate, "PATCH", &host_path, &owner_json, Some(&rename)).await;
    assert_eq!(renamed.0, 200, "{renamed:?}");
    let changed = next(&mut socket, |message| message["type"] == "changed").await;
    assert_eq!(changed["entity"], "host", "{changed}");

    let _ = socket.close(None).await;
    server.close().await;
}
