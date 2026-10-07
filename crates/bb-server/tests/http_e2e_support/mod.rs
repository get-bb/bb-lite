#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Duration, Instant};

use bb_server::config::{ServerEnv, load_config};
use bb_server::db::NowFn;
use bb_server::db::threads::get_thread;
use bb_server::plugins::builtin::BuiltinPlugin;
use bb_server::providers::catalog::enable_dev_providers_for_tests;
use bb_server::runners::local::{LocalRunnerHandle, local_runner_for};
use bb_server::server::{BbServer, CreateServerOptions, create_server};
use reqwest::StatusCode;
use serde_json::{Value, json};
use tempfile::TempDir;

#[derive(Default)]
pub struct BootOptions {
    pub clock: Option<Clock>,
    /// `None` loads every builtin plugin.
    pub builtins: Option<Vec<BuiltinPlugin>>,
    /// Written to the data directory's `config.json` before the server starts.
    pub config_json: Option<Value>,
    pub extra_env: Vec<(String, String)>,
}

#[derive(Clone)]
pub struct Clock(pub Arc<AtomicI64>);

impl Clock {
    pub fn at(ms: i64) -> Self {
        Self(Arc::new(AtomicI64::new(ms)))
    }
    pub fn advance(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
    pub fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
    fn as_fn(&self) -> NowFn {
        let value = self.0.clone();
        Arc::new(move || value.load(Ordering::SeqCst))
    }
}

pub struct Server {
    pub server: BbServer,
    pub url: String,
    pub http: reqwest::Client,
    pub dirs: TempDir,
    local: LocalRunnerHandle,
}

pub async fn boot() -> Server {
    boot_with(BootOptions::default()).await
}

pub async fn boot_with(options: BootOptions) -> Server {
    enable_dev_providers_for_tests();
    let dirs = tempfile::tempdir().unwrap();
    let app_dir = dirs.path().join("app");
    std::fs::create_dir_all(&app_dir).unwrap();
    std::fs::write(app_dir.join("index.html"), "<!doctype html><title>bb test app</title>")
        .unwrap();
    let data_dir = dirs.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();
    if let Some(config) = &options.config_json {
        std::fs::write(data_dir.join("config.json"), config.to_string()).unwrap();
    }
    let path = |name: &str| dirs.path().join(name).to_string_lossy().into_owned();
    let mut env: ServerEnv = [
        ("BB_DATA_DIR", path("data")),
        ("BB_SERVER_PORT", "0".to_owned()),
        ("BB_SERVER_BIND_HOST", "127.0.0.1".to_owned()),
        ("BB_APP_DIR", path("app")),
        ("BB_DEV_PROVIDERS", "echo".to_owned()),
        ("BB_LOG_LEVEL", "silent".to_owned()),
        ("CODEX_HOME", path("codex")),
        ("HOME", path("home")),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value))
    .collect();
    env.extend(options.extra_env);
    let config = load_config(&env).unwrap();
    let adapters = bb_runner::default_adapters();
    let (connect, local) = local_runner_for(&config, adapters);
    let mut create = CreateServerOptions::new(config, connect);
    create.now = options.clock.as_ref().map(Clock::as_fn);
    create.builtins = options.builtins;
    let server = create_server(create).unwrap();
    let listening = server.listen().await.unwrap();
    assert_ne!(listening.port, 0);
    Server { server, url: listening.url, http: reqwest::Client::new(), dirs, local }
}

impl Server {
    pub fn data_dir(&self) -> PathBuf {
        self.dirs.path().join("data")
    }

    pub fn host_id(&self) -> String {
        self.server.ctx.config.host_id.clone()
    }

    pub async fn close(self) {
        self.server.close().await;
        self.local.shutdown().await;
    }

    /// `path` is relative to `/api/v1` unless it starts with `/internal`, `/health` or `/ws`.
    pub fn api_url(&self, path: &str) -> String {
        let raw = ["/internal", "/health", "/ws", "/plugins", "/apps"]
            .iter()
            .any(|prefix| path.starts_with(prefix));
        if raw { format!("{}{path}", self.url) } else { format!("{}/api/v1{path}", self.url) }
    }

    pub async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let method = reqwest::Method::from_bytes(method.as_bytes()).unwrap();
        let mut request = self.http.request(method, self.api_url(path));
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }

    pub async fn get(&self, path: &str) -> (StatusCode, Value) {
        self.request("GET", path, None).await
    }

    pub async fn post(&self, path: &str, body: Value) -> (StatusCode, Value) {
        self.request("POST", path, Some(body)).await
    }

    pub async fn patch(&self, path: &str, body: Value) -> (StatusCode, Value) {
        self.request("PATCH", path, Some(body)).await
    }

    pub async fn delete(&self, path: &str) -> (StatusCode, Value) {
        self.request("DELETE", path, None).await
    }

    pub async fn read(&self, path: &str) -> Value {
        let (status, body) = self.get(path).await;
        assert!(status.is_success(), "GET {path}: {status} {body}");
        body
    }

    pub async fn create_project(&self, name: &str, repo: &Path) -> Value {
        let path = repo.to_string_lossy().into_owned();
        let source = json!({ "hostId": self.host_id(), "type": "local_path", "path": path });
        let (status, project) =
            self.post("/projects", json!({ "name": name, "source": source })).await;
        assert_eq!(status, StatusCode::CREATED, "{project}");
        project
    }

    pub async fn create_thread(&self, body: Value) -> Value {
        let (status, thread) = self.post("/threads", body).await;
        assert_eq!(status, StatusCode::CREATED, "{thread}");
        thread
    }

    pub async fn create_echo_thread(&self, project_id: &str, text: &str) -> String {
        let body = json!({
            "projectId": project_id,
            "origin": "app",
            "providerId": "echo",
            "input": [{ "type": "text", "text": text, "mentions": [] }],
            "environment": { "type": "project-default" },
            "startedOnBehalfOf": null,
        });
        self.create_thread(body).await["id"].as_str().unwrap().to_owned()
    }

    pub fn thread_status(&self, thread_id: &str) -> String {
        let thread = get_thread(&self.server.ctx.db, thread_id).unwrap().unwrap();
        serde_json::to_value(thread.status).unwrap().as_str().unwrap().to_owned()
    }

    pub async fn wait_for_status(&self, thread_id: &str, status: &str) {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let current = self.thread_status(thread_id);
            if current == status {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "thread {thread_id} stayed {current}, wanted {status}"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    pub async fn wait_until<F: FnMut() -> bool>(&self, what: &str, mut ready: F) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !ready() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    pub fn event_types(&self, thread_id: &str) -> Vec<String> {
        let rows = self
            .server
            .ctx
            .db
            .rows("SELECT type FROM events WHERE thread_id = ? ORDER BY sequence", [thread_id])
            .unwrap();
        let rows = serde_json::to_value(rows).unwrap();
        rows.as_array()
            .unwrap()
            .iter()
            .map(|row| row["type"].as_str().unwrap_or("").to_owned())
            .collect()
    }
}

pub fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

pub fn write(root: &Path, files: &[(&str, &str)]) {
    for (file, content) in files {
        let path = root.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
}

/// A temp directory holding `files`, committed on `main`.
pub fn git_repo(files: &[(&str, &str)]) -> TempDir {
    let repo = tempfile::tempdir().unwrap();
    write(repo.path(), files);
    git(repo.path(), &["init", "--quiet", "-b", "main"]);
    git(repo.path(), &["add", "-A"]);
    git(repo.path(), &["commit", "--quiet", "-m", "initial"]);
    repo
}

/// `toMatchObject`: objects match by subset, arrays element-wise with equal length.
pub fn assert_matches(actual: &Value, shape: &Value, at: &str) {
    match (actual, shape) {
        (Value::Object(actual_map), Value::Object(shape_map)) => {
            for (key, expected) in shape_map {
                let value = actual_map.get(key).unwrap_or(&Value::Null);
                assert_matches(value, expected, &format!("{at}.{key}"));
            }
        }
        (Value::Array(actual_items), Value::Array(shape_items)) => {
            assert_eq!(actual_items.len(), shape_items.len(), "{at}: {actual}");
            for (index, (value, expected)) in actual_items.iter().zip(shape_items).enumerate() {
                assert_matches(value, expected, &format!("{at}[{index}]"));
            }
        }
        _ => assert_eq!(actual, shape, "{at}"),
    }
}
