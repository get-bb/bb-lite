mod http_e2e_support;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use http_e2e_support::{BootOptions, Server, assert_matches, boot_with};
use reqwest::StatusCode;
use reqwest::header::HeaderMap;
use serde_json::{Value, json};
use tempfile::TempDir;

const MACHINE: [(&str, &str); 2] = [("x-bb-via-tunnel", "1"), ("x-bb-gate-auth", "machine")];

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn fixture() -> PathBuf {
    repo_root().join("apps/server/test/fixtures/echo-plugin")
}

fn modules_root() -> PathBuf {
    match std::env::var_os("BB_NODE_MODULES_ROOT") {
        Some(root) if !root.is_empty() => PathBuf::from(root),
        _ => repo_root(),
    }
}

/// Points `BB_ESBUILD_PATH` at a wrapper that runs the checkout's esbuild with the server's
/// `node_modules` on `NODE_PATH`, so external plugins bundle from a checkout without its own.
fn use_checkout_esbuild() {
    static WRAPPER: OnceLock<TempDir> = OnceLock::new();
    let dir = WRAPPER.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let root = modules_root();
        let node_path = format!(
            "{}:{}",
            root.join("apps/server/node_modules").display(),
            root.join("node_modules").display()
        );
        let esbuild = root.join("node_modules/.bin/esbuild");
        let script =
            format!("#!/bin/sh\nNODE_PATH='{node_path}' exec '{}' \"$@\"\n", esbuild.display());
        let file = dir.path().join("esbuild");
        std::fs::write(&file, script).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        unsafe { std::env::set_var("BB_ESBUILD_PATH", &file) };
        dir
    });
    assert!(dir.path().join("esbuild").exists());
}

struct Echo {
    server: Server,
    config_file: PathBuf,
}

struct Reply {
    status: StatusCode,
    text: String,
    body: Value,
    headers: HeaderMap,
}

async fn server_with_echo(directory: &Path) -> Echo {
    use_checkout_esbuild();
    let server = boot_with(BootOptions {
        builtins: Some(vec![]),
        config_json: Some(json!({ "plugins": [{ "path": directory }] })),
        ..BootOptions::default()
    })
    .await;
    let config_file = server.data_dir().join("config.json");
    Echo { server, config_file }
}

impl Echo {
    async fn fetch(
        &self,
        url: &str,
        method: &str,
        body: Option<Value>,
        extra: &[(&str, &str)],
    ) -> Reply {
        let method = reqwest::Method::from_bytes(method.as_bytes()).unwrap();
        let mut request = self.server.http.request(method, url);
        for (name, value) in extra {
            request = request.header(*name, *value);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let text = response.text().await.unwrap();
        let json = headers
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("json"));
        let body = if json { serde_json::from_str(&text).unwrap() } else { Value::Null };
        Reply { status, text, body, headers }
    }

    async fn request(&self, path: &str) -> Reply {
        let url = format!("{}/api/v1/plugins{path}", self.server.url);
        self.fetch(&url, "GET", None, &[]).await
    }

    async fn send(&self, path: &str, body: Value, extra: &[(&str, &str)]) -> Reply {
        let url = format!("{}/api/v1/plugins{path}", self.server.url);
        self.fetch(&url, "POST", Some(body), extra).await
    }

    async fn rpc(&self, path: &str, input: Value) -> (u16, Value) {
        let reply = self.send(&format!("/{path}"), input, &[]).await;
        let body = reply.body;
        let outcome = match body.get("result") {
            Some(result) if !result.is_null() => result.clone(),
            _ => body["error"]["code"].clone(),
        };
        (reply.status.as_u16(), outcome)
    }

    fn kv(&self, key: &str) -> Option<String> {
        let sql = "SELECT value FROM plugin_kv WHERE plugin_id = 'echo' AND key = ?";
        let rows = self.server.server.ctx.db.rows(sql, [key]).unwrap();
        rows.first().and_then(|row| row["value"].as_str().map(str::to_owned))
    }

    async fn reload(&self, query: &str) -> Vec<Value> {
        let reply = self.send(&format!("/reload{query}"), json!({}), &[]).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
        reply.body["plugins"].as_array().unwrap().clone()
    }
}

#[tokio::test]
async fn restarts_a_crashed_service_and_disposes_a_disabled_plugin() {
    let echo = server_with_echo(&fixture()).await;
    let deadline = Instant::now() + Duration::from_secs(5);
    while echo.kv("starts").as_deref() != Some("2") {
        assert!(Instant::now() < deadline, "starts stayed {:?}", echo.kv("starts"));
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(echo.kv("disposed"), None);
    assert_eq!(echo.send("/echo/disable", json!({}), &MACHINE).await.status, StatusCode::FORBIDDEN);
    let plugin = json!({ "enabled": false, "status": "disabled", "cliCommands": [] });
    let disabled = echo.send("/echo/disable", json!({}), &[]).await;
    assert_matches(&disabled.body, &json!({ "ok": true, "plugin": plugin }), "disabled");
    assert_eq!(echo.kv("disposed").as_deref(), Some("true"));
    let unavailable = (503, json!("plugin_unavailable"));
    assert_eq!(echo.rpc("echo/rpc/echo", json!({ "text": "x" })).await, unavailable);
    assert_eq!(echo.request("/echo/http/none").await.status.as_u16(), 503);
    let scope = json!({ "argv": ["say", "x"], "cwd": "/work", "threadId": "thr_1" });
    let cli = echo.send("/echo/cli", scope, &[]).await;
    let cli: Value = serde_json::from_str(&cli.text).unwrap();
    let stderr = cli["stderr"].as_str().unwrap();
    assert!(stderr.contains("not running"), "{stderr}");
    let enabled = echo.send("/echo/enable", json!({}), &[]).await;
    assert_matches(&enabled.body, &json!({ "plugin": { "status": "running" } }), "enabled");
    assert_eq!(echo.rpc("echo/rpc/echo", json!({ "text": "x" })).await.0, 200);
    echo.server.close().await;
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

#[tokio::test]
async fn reloads_a_changed_external_plugin_and_refuses_rewritten_migrations() {
    let scratch = tempfile::tempdir().unwrap();
    let directory = scratch.path().join("echo");
    copy_dir(&fixture(), &directory);
    let echo = server_with_echo(&directory).await;
    let source = directory.join("server.ts");
    let edit = |from: &str, to: &str| {
        let text = std::fs::read_to_string(&source).unwrap();
        std::fs::write(&source, text.replacen(from, to, 1)).unwrap();
    };
    echo.rpc("echo/rpc/echo", json!({ "text": "a" })).await;
    edit("default: \"hello\"", "default: \"howdy\"");
    edit("NOT NULL)\"]", "NOT NULL)\", \"CREATE TABLE extra (id INTEGER)\"]");
    echo.reload("?id=echo").await;
    let echoed = json!({ "text": "howdy b", "calls": 2 });
    assert_eq!(echo.rpc("echo/rpc/echo", json!({ "text": "b" })).await, (200, echoed));
    edit("extra (id INTEGER)", "extra (id TEXT)");
    let reloaded = echo.reload("").await;
    let last = reloaded.last().unwrap();
    assert_eq!(last["status"], "error", "{last}");
    let message = last["statusMessage"].as_str().unwrap_or_default();
    assert!(message.contains("Migration 1 changed"), "{message}");
    std::fs::write(&echo.config_file, json!({ "plugins": [] }).to_string()).unwrap();
    let ids: Vec<Value> = echo.reload("").await.iter().map(|plugin| plugin["id"].clone()).collect();
    assert!(!ids.contains(&json!("echo")), "{ids:?}");
    echo.server.close().await;
}

const APP_RUNNER: &str = r#"
const jsx = (type, props) => ({ type, props });
const useState = (value) => [value];
const clsx = (...names) => names.join(" ");
globalThis.__bbPluginRuntime = {
  react: { default: { useState }, useState },
  "react/jsx-runtime": { jsx },
  clsx: { default: clsx, clsx },
  "@bb/plugin/app": { definePluginApp: (setup) => ({ setup }) },
};
const { pathToFileURL } = await import("node:url");
const app = await import(pathToFileURL(process.argv[2]).href);
const panels = [];
const slots = { navPanel: (panel) => panels.push(panel) };
app.default?.setup({ slots });
process.stdout.write(JSON.stringify(panels[0]?.component() ?? null));
"#;

fn run_app_script(script: &str) -> Value {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app.mjs");
    let runner = dir.path().join("runner.mjs");
    std::fs::write(&app, script).unwrap();
    std::fs::write(&runner, APP_RUNNER).unwrap();
    let output = std::process::Command::new("node")
        .arg(&runner)
        .arg(&app)
        .current_dir(dir.path())
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout).unwrap()
}

#[tokio::test]
async fn serves_an_external_app_bundle_whose_shared_imports_resolve_at_runtime() {
    let echo = server_with_echo(&fixture()).await;
    let listing = echo.request("").await.body;
    let app = listing["plugins"].as_array().unwrap().last().unwrap()["app"].clone();
    assert_eq!(app["kind"], "external", "echo has no external app: {listing}");
    let url = |key: &str| format!("{}{}", echo.server.url, app[key].as_str().unwrap());
    let script = echo.fetch(&url("jsUrl"), "GET", None, &[]).await;
    let header = |name: &str| script.headers[name].to_str().unwrap().to_owned();
    assert!(header("content-type").contains("text/javascript"), "{}", header("content-type"));
    assert!(header("cache-control").contains("immutable"), "{}", header("cache-control"));
    let styles = echo.fetch(&url("cssUrl"), "GET", None, &[]).await;
    assert!(styles.text.contains(".echo-panel"), "{}", styles.text);
    let props = json!({ "className": "echo-panel flex", "children": 2 });
    assert_eq!(run_app_script(&script.text), json!({ "type": "div", "props": props }));
    echo.server.close().await;
}
