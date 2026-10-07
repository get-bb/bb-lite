mod support;

use bb_cli::call::CliEnv;
use serde_json::{Value, json};
use support::{FakeServer, Request, route, run};

fn request(method: &str, path: &str, body: Option<Value>) -> Request {
    Request { method: method.into(), path: path.into(), body }
}

fn config(data_dir: &str) -> Value {
    json!({
        "dataDir": data_dir,
        "primaryHostId": "host_1",
        "generalSettings": { "streamerMode": false },
        "appearance": { "themeId": "default", "faviconColor": "blue" },
        "keybindingOverrides": [{ "command": "x.y",
            "shortcut": { "key": "k", "mod": true, "shift": true } }],
    })
}

fn settings_server() -> FakeServer {
    let ui = json!({ "preferences": { "sidebarWidth": { "value": 300, "revision": 2 } } });
    FakeServer::start(vec![
        route("GET", "/system/config", config("/data")),
        route("GET", "/preferences/ui", ui),
        route("PUT", "/settings/general", json!({})),
        route("PUT", "/settings/keyboard", json!([])),
    ])
}

#[test]
fn settings_show_lists_every_key() {
    let server = settings_server();
    let (result, printed) = run(&server, &["settings", "show"], CliEnv::default());
    result.unwrap();
    let expected = "streamerMode = false\ntheme = \"default\"\ntheme.faviconColor = \"blue\"\n\
        keybinding.x.y = \"mod+shift+k\"\nui.sidebarWidth = 300\n";
    assert_eq!(printed, expected);
    let (result, printed) = run(&server, &["settings", "get", "theme"], CliEnv::default());
    result.unwrap();
    assert_eq!(printed, "default\n");
}

#[test]
fn settings_set_writes_general_settings_and_keybindings() {
    let server = settings_server();
    let (result, printed) =
        run(&server, &["settings", "set", "streamerMode", "true"], CliEnv::default());
    result.unwrap();
    assert_eq!(printed, "streamerMode = false\n");
    let words = ["settings", "set", "keybinding.a.b", "Ctrl+Shift+P"];
    run(&server, &words, CliEnv::default()).0.unwrap();
    let (result, _) = run(&server, &["settings", "set", "ui.nope", "1"], CliEnv::default());
    let error = result.unwrap_err();
    assert_eq!(error.message, "Unknown UI preference 'nope'.");
    assert_eq!(error.hint.as_deref(), Some("Known: sidebarWidth"));
    let (result, _) = run(&server, &["settings", "set", "bogus", "1"], CliEnv::default());
    assert_eq!(result.unwrap_err().message, "Unknown setting 'bogus'.");
    let puts: Vec<Request> = server.requests().into_iter().filter(|r| r.method == "PUT").collect();
    let combo = json!({ "key": "p", "mod": false, "meta": false, "control": true,
        "alt": false, "shift": true });
    assert_eq!(
        puts,
        [
            request("PUT", "/settings/general", Some(json!({ "streamerMode": true }))),
            request(
                "PUT",
                "/settings/keyboard",
                Some(json!([
                    { "command": "x.y", "shortcut": { "key": "k", "mod": true, "shift": true } },
                    { "command": "a.b", "shortcut": combo },
                ]))
            ),
        ]
    );
}

#[test]
fn plugin_list_add_and_remove() {
    let root = std::env::temp_dir().join(format!("bb-cli-plugin-{}", std::process::id()));
    let (data, plugin) = (root.join("data"), root.join("plugin"));
    std::fs::create_dir_all(&data).unwrap();
    std::fs::create_dir_all(&plugin).unwrap();
    std::fs::write(plugin.join("package.json"), "{}").unwrap();
    let listed = json!({ "plugins": [{ "id": "tasks", "status": "running",
        "cliCommands": [{ "name": "tasks" }], "statusMessage": null, "description": "Tasks" }] });
    let server = FakeServer::start(vec![
        route("GET", "/plugins", listed.clone()),
        route("GET", "/system/config", config(data.to_str().unwrap())),
        route("POST", "/plugins/reload", listed),
    ]);
    let (result, printed) = run(&server, &["plugin", "list"], CliEnv::default());
    result.unwrap();
    assert_eq!(printed, "\nID     STATUS   COMMANDS  ABOUT\ntasks  running  bb tasks  Tasks\n\n");
    let path = plugin.to_str().unwrap();
    let file = data.join("config.json");
    let (result, printed) = run(&server, &["plugin", "add", path], CliEnv::default());
    result.unwrap();
    assert_eq!(printed, format!("{path} added to {}; plugins reloaded\n", file.display()));
    let written = std::fs::read_to_string(&file).unwrap();
    let expected = json!({ "plugins": [{ "path": path, "enabled": true }] });
    assert_eq!(written, format!("{}\n", serde_json::to_string_pretty(&expected).unwrap()));
    let (result, _) = run(&server, &["plugin", "remove", path, "--yes"], CliEnv::default());
    result.unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\n  \"plugins\": []\n}\n");
    let reloads = server.requests().into_iter().filter(|r| r.method == "POST").count();
    assert_eq!(reloads, 2);
    let (result, _) = run(&server, &["plugin", "add", data.to_str().unwrap()], CliEnv::default());
    assert_eq!(result.unwrap_err().message, format!("{} has no package.json.", data.display()));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn file_commands_post_to_the_files_routes() {
    let server = FakeServer::start(vec![
        route("POST", "/files/read", json!({ "content": "hi\n", "contentEncoding": "utf8" })),
        route("POST", "/files/write", json!({ "outcome": "written" })),
        route("POST", "/files/list", json!({ "files": [{ "path": "a" }, { "path": "b" }] })),
    ]);
    let env = CliEnv::default;
    let (result, printed) = run(&server, &["file", "read", "/a", "--machine", "host_1"], env());
    result.unwrap();
    assert_eq!(printed, "hi\n");
    let (result, printed) = run(&server, &["file", "write", "/a", "--content", "x"], env());
    result.unwrap();
    assert_eq!(printed, "Wrote /a\n");
    let (result, _) = run(&server, &["file", "write", "/a"], env());
    assert_eq!(result.unwrap_err().message, "Provide exactly one of --content or --stdin.");
    let (result, printed) = run(&server, &["file", "list", "/src", "--limit", "2"], env());
    result.unwrap();
    assert_eq!(printed, "a\nb\n");
    assert_eq!(
        server.requests(),
        [
            request("POST", "/files/read", Some(json!({ "hostId": "host_1", "path": "/a" }))),
            request("POST", "/files/write", Some(json!({ "path": "/a", "content": "x" }))),
            request("POST", "/files/list", Some(json!({ "limit": 2, "path": "/src" }))),
        ]
    );
}

#[test]
fn server_status_reports_the_data_directory() {
    let server = FakeServer::start(vec![route("GET", "/system/config", config("/data"))]);
    let (result, printed) = run(&server, &["server", "status"], CliEnv::default());
    result.unwrap();
    assert_eq!(printed, format!("bb server at {} (data in /data)\n", server.url));
}
