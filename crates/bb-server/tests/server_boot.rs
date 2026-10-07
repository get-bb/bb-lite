use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use bb_server::config::ServerEnv;
use bb_server::db::threads::get_thread;
use bb_server::providers::catalog::enable_dev_providers_for_tests;
use bb_server::start::{RunningServer, StartServerOptions, start_server};
use futures::{SinkExt, StreamExt};
use reqwest::StatusCode;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message;

struct Booted {
    running: RunningServer,
    url: String,
    http: reqwest::Client,
    _dirs: TempDir,
}

async fn boot() -> Booted {
    enable_dev_providers_for_tests();
    let dirs = tempfile::tempdir().unwrap();
    let app_dir = dirs.path().join("app");
    std::fs::create_dir_all(&app_dir).unwrap();
    std::fs::write(app_dir.join("index.html"), "<!doctype html><title>bb test app</title>")
        .unwrap();
    let path = |name: &str| dirs.path().join(name).to_string_lossy().into_owned();
    let env: ServerEnv = [
        ("BB_DATA_DIR", path("data")),
        ("BB_SERVER_PORT", "0".to_owned()),
        ("BB_SERVER_BIND_HOST", "127.0.0.1".to_owned()),
        ("BB_APP_DIR", path("app")),
        ("BB_DEV_PROVIDERS", "echo".to_owned()),
        ("BB_LOG_LEVEL", "silent".to_owned()),
        ("CODEX_HOME", path("codex")),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value))
    .collect();
    let running = start_server(StartServerOptions { env, cli_dir: None }).await.unwrap();
    let url = running.listening.url.clone();
    assert_ne!(running.listening.port, 0);
    Booted { running, url, http: reqwest::Client::new(), _dirs: dirs }
}

impl Booted {
    async fn request(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let method = reqwest::Method::from_bytes(method.as_bytes()).unwrap();
        let mut request = self.http.request(method, format!("{}{path}", self.url));
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }

    async fn get(&self, path: &str) -> (StatusCode, Value) {
        self.request("GET", path, None).await
    }

    async fn wait_idle(&self, thread_id: &str, turns: usize) -> String {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let db = &self.running.server.ctx.db;
            let thread = get_thread(db, thread_id).unwrap().unwrap();
            let events = db
                .rows("SELECT * FROM events WHERE thread_id = ? ORDER BY sequence", [thread_id])
                .unwrap();
            let events = serde_json::to_string(&events).unwrap();
            let status = serde_json::to_value(thread.status).unwrap();
            if status == "idle" && events.matches("turn/completed").count() >= turns {
                return events;
            }
            assert!(Instant::now() < deadline, "thread stayed {status}: {events}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn create_thread(&self, text: &str) -> String {
        let body = json!({
            "projectId": "proj_personal",
            "origin": "app",
            "providerId": "echo",
            "input": [{ "type": "text", "text": text, "mentions": [] }],
            "environment": { "type": "project-default" },
            "startedOnBehalfOf": null,
        });
        let (status, thread) = self.request("POST", "/api/v1/threads", Some(body)).await;
        assert_eq!(status, StatusCode::CREATED, "{thread}");
        thread["id"].as_str().unwrap().to_owned()
    }
}

#[tokio::test]
async fn serves_health_api_errors_config_and_the_web_app() {
    let server = boot().await;
    let (status, health) = server.get("/health").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health["ok"], true);
    assert_eq!(health["version"], server.running.server.ctx.config.version.as_str());

    let (status, missing) = server.get("/api/v1/no-such-route").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(missing["code"], "not_found", "{missing}");
    let (status, missing) = server.get("/internal/no-such-route").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(missing["code"], "not_found", "{missing}");

    let (status, runner) = server.get("/internal/runner/ws").await;
    assert_ne!(status, StatusCode::NOT_FOUND, "{runner}");

    let (status, config) = server.get("/api/v1/system/config").await;
    assert_eq!(status, StatusCode::OK, "{config}");
    assert!(config.is_object(), "{config}");

    let (status, page) = server.get("/threads/some-thread").await;
    assert_eq!(status, StatusCode::OK);
    assert!(page.as_str().unwrap().contains("bb test app"));

    let foreign = server
        .http
        .get(format!("{}/api/v1/system/config", server.url))
        .header("origin", "https://evil.example")
        .send()
        .await
        .unwrap();
    assert!(foreign.status().is_client_error(), "{}", foreign.status());
    server.running.shutdown().await;
}

#[tokio::test]
async fn lists_echo_providers_and_execution_options() {
    let server = boot().await;
    let (status, providers) = server.get("/api/v1/system/providers").await;
    assert_eq!(status, StatusCode::OK, "{providers}");
    assert!(providers.to_string().contains("\"echo\""), "{providers}");

    let (status, options) = server.get("/api/v1/system/execution-options?providerId=echo").await;
    assert_eq!(status, StatusCode::OK, "{options}");
    assert!(options["providers"].as_array().unwrap().iter().any(|p| p["id"] == "echo"));
    assert!(options["permissionCeiling"].is_string(), "{options}");
    assert!(!options["models"].as_array().unwrap().is_empty(), "{options}");

    let (status, error) = server.get("/api/v1/system/execution-options?providerId=nope").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["message"], "Unsupported provider nope");
    server.running.shutdown().await;
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

#[tokio::test]
async fn creates_a_project_from_a_git_repository() {
    let server = boot().await;
    let repo = tempfile::tempdir().unwrap();
    git(repo.path(), &["init", "-q", "-b", "main"]);
    std::fs::write(repo.path().join("README.md"), "hello\n").unwrap();
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
    let host_id = server.running.server.ctx.config.host_id.clone();
    let path = repo.path().to_string_lossy().into_owned();
    let body = json!({ "name": "Repo", "source": { "hostId": host_id, "type": "local_path", "path": path } });
    let (status, project) = server.request("POST", "/api/v1/projects", Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{project}");
    let (status, list) = server.get("/api/v1/projects").await;
    assert_eq!(status, StatusCode::OK);
    assert!(list.as_array().unwrap().iter().any(|entry| entry["id"] == project["id"]));

    let project_id = project["id"].as_str().unwrap();
    let query =
        format!("/api/v1/system/environment-providers?projectId={project_id}&hostId={host_id}");
    let (status, listed) = server.get(&query).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    let providers = listed["providers"].as_array().unwrap();
    let ids: Vec<&str> = providers.iter().map(|p| p["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["project-checkout", "git-worktree"]);
    assert_eq!(providers[0]["availability"], Value::Null);
    assert_eq!(providers[1]["availability"], json!({ "status": "available" }));
    assert_eq!(providers[1]["machineAvailability"][&host_id], json!({ "status": "available" }));
    assert_eq!(providers[1]["pluginId"], "environment-git-worktree");
    let inputs = serde_json::to_string(&providers[0]["inputs"]).unwrap();
    assert!(inputs.starts_with(
        r#"{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object""#
    ));

    let query = "/api/v1/system/environment-providers?projectId=proj_personal";
    let (status, listed) = server.get(query).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed["providers"].as_array().unwrap().len(), 1);
    assert_eq!(listed["providers"][0]["id"], "personal-workspace");
    assert_eq!(listed["providers"][0]["inputs"], Value::Null);
    assert_eq!(listed["providers"][0]["machineAvailability"], json!({ host_id.clone(): null }));

    let (_, all) = server.get("/api/v1/system/environment-providers").await;
    assert_eq!(all["providers"].as_array().unwrap().len(), 3);
    server.running.shutdown().await;
}

#[tokio::test]
async fn runs_echo_turns_and_announces_thread_changes() {
    let server = boot().await;
    let ws_url = format!("{}/ws", server.url.replace("http://", "ws://"));
    let (mut socket, _) = tokio_tungstenite::connect_async(ws_url).await.unwrap();
    let subscribe = json!({ "type": "subscribe", "target": { "kind": "thread-list" } });
    socket.send(Message::text(subscribe.to_string())).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;

    let thread_id = server.create_thread("hello there").await;
    let changed = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(message) = socket.next().await {
            if let Message::Text(text) = message.unwrap() {
                let value: Value = serde_json::from_str(&text).unwrap();
                if value["type"] == "changed" {
                    return value;
                }
            }
        }
        panic!("socket closed");
    })
    .await
    .unwrap();
    assert_eq!(changed["type"], "changed", "{changed}");

    let events = server.wait_idle(&thread_id, 1).await;
    assert!(events.contains("Response to: hello there"), "{events}");

    let body =
        json!({ "input": [{ "type": "text", "text": "second", "mentions": [] }], "mode": "auto" });
    let path = format!("/api/v1/threads/{thread_id}/send");
    let (status, sent) = server.request("POST", &path, Some(body)).await;
    assert!(status.is_success(), "{status} {sent}");
    let events = server.wait_idle(&thread_id, 2).await;
    assert!(events.contains("Response to: second"), "{events}");
    server.running.shutdown().await;
}
