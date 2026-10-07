#![allow(clippy::result_large_err)]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use base64::Engine;
use bb_core::{RunnerApi, RunnerError, RunnerErrorCode, RunnerEvent, RunnerEventBody};
use bb_core::{RunnerEventSink, RunnerResult, SharedRunner};
use bb_server::config::ServerConfig;
use bb_server::context::{Ctx, ServerContext};
use bb_server::db::environments::{EnvironmentPatch, NewEnvironment, insert_environment};
use bb_server::db::environments::{get_environment, update_environment};
use bb_server::db::{Db, params};
use bb_server::domain::changes::ChangedMessage;
use bb_server::domain::environment::EnvironmentStatus;
use bb_server::environments::watch::start_workspace_watch;
use bb_server::http::compression::Uncompressed;
use bb_server::http::routes::{environments, files};
use bb_server::http::trust::Principal;
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::runners::registry::RunnerRegistry;
use bb_server::ws::hub::{Hub, HubSocket};
use http_body_util::BodyExt;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tower::ServiceExt;

const HOST: &str = "host_a";
const FILE: &[u8] = b"0123456789abcdef";

type Answer = Box<dyn Fn(&str, &Value) -> RunnerResult<Value> + Send + Sync>;

struct Fake {
    calls: Mutex<Vec<(String, Value)>>,
    answer: Mutex<Answer>,
    sink: Mutex<Option<RunnerEventSink>>,
}

#[async_trait]
impl RunnerApi for Fake {
    async fn call(&self, method: &str, params: Value) -> RunnerResult<Value> {
        self.calls.lock().push((method.to_owned(), params.clone()));
        (self.answer.lock())(method, &params)
    }
}

fn standard(method: &str, params: &Value) -> RunnerResult<Value> {
    Ok(match method {
        "gitStatus" => json!({ "branch": { "currentBranch": "feature", "defaultBranch": "main" } }),
        "gitDiffFiles" => json!({ "files": [{ "path": "a.txt" }] }),
        "gitCommit" => json!({ "commitSha": "abc123" }),
        "readFileChunk" => {
            let offset = params["offset"].as_u64().unwrap() as usize;
            let length = params["length"].as_u64().unwrap() as usize;
            let data = &FILE[offset..offset + length];
            json!({
                "path": params["path"], "sizeBytes": FILE.len(), "modifiedAtMs": null,
                "mimeType": "text/plain", "revision": "rev1", "offset": offset,
                "dataBase64": base64::engine::general_purpose::STANDARD.encode(data),
            })
        }
        "readFile" => json!({ "path": params["path"], "content": "hi" }),
        "listPaths" => json!({ "paths": [{ "path": "a.txt", "name": "a.txt", "kind": "file" }],
            "truncated": false }),
        _ => json!({ "ok": true }),
    })
}

struct World {
    ctx: Ctx,
    fake: Arc<Fake>,
    app: Router,
}

impl World {
    fn new() -> Self {
        let db = Db::open_in_memory(None).unwrap();
        let sql = "INSERT INTO hosts (id, name, created_at, updated_at) VALUES (?, 'a', 1, 1)";
        db.run(sql, [HOST]).unwrap();
        let sql =
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('prj', 'demo', 1, 1)";
        db.run(sql, []).unwrap();
        let config = ServerConfig {
            data_dir: PathBuf::from("/nonexistent-bb-test"),
            port: 0,
            bind_host: "127.0.0.1".into(),
            allowed_hosts: vec![],
            app_dir: PathBuf::new(),
            cli_dir: PathBuf::new(),
            bb_cli_path: PathBuf::new(),
            version: "test".into(),
            host_id: HOST.into(),
            log_level: LogLevel::Warn,
        };
        let hub = Hub::new();
        let log = Logger::silent();
        let plugins = PluginHost::new(PluginHostOptions {
            config: config.clone(),
            db: db.clone(),
            hub: hub.clone(),
            log: log.clone(),
            builtins: Some(vec![]),
        });
        let ctx = Arc::new(ServerContext {
            config,
            db,
            hub,
            runners: RunnerRegistry::new(HOST, log.clone()),
            plugins,
            log,
            engine: Default::default(),
            environments: Default::default(),
            terminals: Default::default(),
        });
        let fake = Arc::new(Fake {
            calls: Mutex::default(),
            answer: Mutex::new(Box::new(standard)),
            sink: Mutex::default(),
        });
        let runner = fake.clone();
        ctx.runners.connect(
            HOST,
            Box::new(move |sink| {
                *runner.sink.lock() = Some(sink);
                runner as SharedRunner
            }),
        );
        let app = environments::register_environment_routes()
            .merge(files::register_file_routes())
            .with_state(ctx.clone());
        Self { ctx, fake, app }
    }

    fn environment(&self, git: bool) -> String {
        let id = insert_environment(
            &self.ctx.db,
            &NewEnvironment {
                project_id: "prj".into(),
                host_id: HOST.into(),
                path: Some("/repo".into()),
                environment_provider_id: "local".into(),
                owner_thread_id: None,
                instance_key: None,
            },
        )
        .unwrap();
        let patch = EnvironmentPatch {
            status: Some(EnvironmentStatus::Ready),
            is_git_repo: Some(git),
            ..Default::default()
        };
        update_environment(&self.ctx.db, &id, &patch).unwrap();
        id
    }

    fn calls(&self, method: &str) -> Vec<Value> {
        let calls = self.fake.calls.lock();
        calls.iter().filter(|(name, _)| name == method).map(|(_, params)| params.clone()).collect()
    }

    fn fail(&self, method: &'static str, code: RunnerErrorCode) {
        *self.fake.answer.lock() = Box::new(move |name, params| {
            if name == method {
                Err(RunnerError::new(code, "boom"))
            } else {
                standard(name, params)
            }
        });
    }

    async fn send(&self, method: &str, uri: &str, body: Option<Value>) -> axum::response::Response {
        let mut request = Request::builder().method(method).uri(uri);
        if body.is_some() {
            request = request.header("content-type", "application/json");
        }
        let body = body.map_or_else(Body::empty, |body| Body::from(body.to_string()));
        let mut request = request.body(body).unwrap();
        request.extensions_mut().insert(Principal::Owner);
        self.app.clone().oneshot(request).await.unwrap()
    }

    async fn json(&self, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let response = self.send(method, uri, body).await;
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }
}

fn record_changes(ctx: &Ctx) -> (Arc<Mutex<Vec<String>>>, bb_server::ws::hub::ListenerGuard) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let guard = ctx.hub.on_changed(move |message| {
        if let ChangedMessage::Environment { id, changes } = message {
            for kind in changes {
                sink.lock().push(format!("{id}:{}", kind.as_str()));
            }
        }
    });
    (seen, guard)
}

#[tokio::test]
async fn status_is_available_and_records_branch_metadata() {
    let world = World::new();
    let id = world.environment(true);
    let (seen, _guard) = record_changes(&world.ctx);
    let uri = format!("/environments/{id}/status?mergeBaseBranch=main");
    let (status, body) = world.json("GET", &uri, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["outcome"], "available");
    assert_eq!(body["workspace"]["branch"]["currentBranch"], "feature");
    assert_eq!(world.calls("gitStatus")[0], json!({ "path": "/repo", "mergeBaseBranch": "main" }));
    let stored = get_environment(&world.ctx.db, &id).unwrap().unwrap();
    assert_eq!(stored.branch_name.as_deref(), Some("feature"));
    assert_eq!(stored.default_branch.as_deref(), Some("main"));
    assert_eq!(*seen.lock(), vec![format!("{id}:metadata-changed")]);
}

#[tokio::test]
async fn status_reports_each_failure_as_unavailable() {
    let world = World::new();
    let id = world.environment(true);
    let uri = format!("/environments/{id}/status");
    for (code, expected) in [
        (RunnerErrorCode::PathNotFound, "path_not_found"),
        (RunnerErrorCode::NotGitRepo, "not_git_repo"),
        (RunnerErrorCode::PermissionDenied, "permission_denied"),
        (RunnerErrorCode::Unavailable, "unknown"),
    ] {
        world.fail("gitStatus", code);
        let (status, body) = world.json("GET", &uri, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["outcome"], "unavailable");
        let failure = json!({ "code": expected, "workspacePath": "/repo", "message": "boom" });
        assert_eq!(body["failure"], failure);
    }
    world.fail("gitStatus", RunnerErrorCode::Failed);
    let (status, _) = world.json("GET", &uri, None).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    world.ctx.runners.disconnect(HOST, None);
    let (status, body) = world.json("GET", &uri, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["failure"]["code"], "unknown");
    assert_eq!(body["failure"]["message"], "Host is not connected");
}

#[tokio::test]
async fn non_git_and_unready_environments() {
    let world = World::new();
    let id = world.environment(false);
    let (_, body) = world.json("GET", &format!("/environments/{id}/status"), None).await;
    assert_eq!(body["outcome"], "not_applicable");
    assert_eq!(body["message"], "Workspace status is not available for non-git environments");
    let patch = EnvironmentPatch { status: Some(EnvironmentStatus::Error), ..Default::default() };
    update_environment(&world.ctx.db, &id, &patch).unwrap();
    let paths = format!("/environments/{id}/paths?includeFiles=true&includeDirectories=true");
    let (status, body) = world.json("GET", &paths, None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "environment_not_ready");
    assert_eq!(body["details"], json!({ "environmentStatus": "error", "hasPath": true }));
    let (status, body) = world.json("GET", "/environments/env_missing", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "environment_not_found");
}

#[tokio::test]
async fn diffs_and_paths_are_forwarded() {
    let world = World::new();
    let id = world.environment(true);
    let uri = format!("/environments/{id}/diff/files?target=all&mergeBaseBranch=main");
    let (_, body) = world.json("GET", &uri, None).await;
    assert_eq!(body, json!({ "outcome": "available", "files": [{ "path": "a.txt" }] }));
    let target = json!({ "type": "all", "mergeBaseBranch": "main" });
    assert_eq!(world.calls("gitDiffFiles")[0], json!({ "path": "/repo", "target": target }));
    let uri = format!("/environments/{id}/diff/patch");
    let body = json!({ "target": { "type": "uncommitted" }, "paths": ["a.txt"] });
    world.json("POST", &uri, Some(body)).await;
    let sent = json!({ "path": "/repo", "target": { "type": "uncommitted" }, "paths": ["a.txt"] });
    assert_eq!(world.calls("gitDiffPatch")[0], sent);
    let uri = format!("/environments/{id}/diff/branches?query=%20fe%20&limit=5000");
    world.json("GET", &uri, None).await;
    assert_eq!(
        world.calls("listBranches")[0],
        json!({ "path": "/repo", "query": "fe", "limit": 1000 })
    );
    let uri = format!("/environments/{id}/paths?includeFiles=true&includeDirectories=false");
    let (status, _) = world.json("GET", &uri, None).await;
    assert_eq!(status, StatusCode::OK);
    let listed = &world.calls("listPaths")[0];
    assert_eq!(listed["limit"], 1000);
    assert_eq!(listed["excludeNames"][0], "node_modules");
    let uri = format!("/environments/{id}/paths?includeFiles=false&includeDirectories=false");
    let (status, body) = world.json("GET", &uri, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["message"], "At least one path kind must be included");
}

#[tokio::test]
async fn file_routes_forward_to_the_runner() {
    let world = World::new();
    let body = json!({ "hostId": HOST, "path": "a.txt", "rootPath": "/repo" });
    let (status, read) = world.json("POST", "/files/read", Some(body)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read["content"], "hi");
    assert_eq!(world.calls("readFile")[0], json!({ "path": "a.txt", "rootPath": "/repo" }));
    let (_, listed) = world.json("POST", "/files/list", Some(json!({ "path": "/repo" }))).await;
    assert_eq!(
        listed,
        json!({ "files": [{ "path": "a.txt", "name": "a.txt" }], "truncated": false })
    );
    let search = &world.calls("listPaths")[0];
    assert_eq!(search["rootPath"], "/repo");
    assert_eq!(search["includeDirectories"], false);
    world.json("GET", &format!("/hosts/{HOST}/directory?path=/tmp"), None).await;
    assert_eq!(world.calls("browseDirectory")[0], json!({ "path": "/tmp" }));
}

#[tokio::test]
async fn serves_a_file_byte_range() {
    let world = World::new();
    let id = world.environment(true);
    let uri = format!("/environments/{id}/files/src/a.txt");
    let request = Request::get(&uri).header("range", "bytes=2-5");
    let mut request = request.body(Body::empty()).unwrap();
    request.extensions_mut().insert(Principal::Owner);
    let response = world.app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert!(response.extensions().get::<Uncompressed>().is_some());
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&bytes[..], b"2345");
    assert_eq!(world.calls("readFileChunk")[0]["path"], "/repo/src/a.txt");
    let (status, _) = world.json("GET", &format!("/environments/{id}/files/../x"), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn commits_and_refuses_without_changes() {
    let world = World::new();
    let id = world.environment(true);
    let (seen, _guard) = record_changes(&world.ctx);
    let uri = format!("/environments/{id}/actions");
    let (status, body) = world.json("POST", &uri, Some(json!({ "action": "commit" }))).await;
    assert_eq!(status, StatusCode::OK);
    let expected = json!({ "ok": true, "action": "commit", "message": "Created commit abc123",
        "commitSha": "abc123" });
    assert_eq!(body, expected);
    assert_eq!(world.calls("gitCommit")[0]["message"], "bb: automated commit");
    assert!(seen.lock().contains(&format!("{id}:git-refs-changed")));
    world.fail("gitCommit", RunnerErrorCode::NoChanges);
    let (status, body) = world.json("POST", &uri, Some(json!({ "action": "commit" }))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["message"], "No uncommitted changes to commit");
    world.fail("gitCommit", RunnerErrorCode::PathNotFound);
    let (status, body) = world.json("POST", &uri, Some(json!({ "action": "commit" }))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "workspace_unavailable");
    assert_eq!(body["details"]["failure"]["code"], "path_not_found");
}

#[tokio::test]
async fn renames_and_refuses_deleting_a_used_environment() {
    let world = World::new();
    let id = world.environment(true);
    let (status, body) = world
        .json("PATCH", &format!("/environments/{id}"), Some(json!({ "name": " Mine " })))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["name"], "Mine");
    let sql = "INSERT INTO threads (id, project_id, environment_id, provider_id, status, title,
      latest_attention_at, created_at, updated_at)
      VALUES ('thr_1', 'prj', ?, 'echo', 'idle', 't', 1, 1, 1)";
    world.ctx.db.run(sql, params![id]).unwrap();
    let (status, body) = world.json("DELETE", &format!("/environments/{id}"), None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["message"], "Environment still has live threads");
}

struct Socket;

impl HubSocket for Socket {
    fn send(&self, _data: String) -> bool {
        true
    }
    fn close(&self, _code: u16, _reason: &str) {}
}

#[tokio::test(start_paused = true)]
async fn watches_subscribed_environments_and_relays_changes() {
    let world = World::new();
    let id = world.environment(true);
    let _watch = start_workspace_watch(&world.ctx);
    let (seen, _guard) = record_changes(&world.ctx);
    let socket = world.ctx.hub.connect(Arc::new(Socket));
    let target = json!({ "kind": "environment-detail", "environmentId": id });
    let message = json!({ "type": "subscribe", "target": target });
    world.ctx.hub.receive(socket, &message.to_string());
    tokio::time::sleep(Duration::from_millis(300)).await;
    let watched = world.calls("setWatchedPaths");
    assert_eq!(watched.len(), 1);
    assert_eq!(watched[0]["workspaces"], json!(["/repo"]));
    assert_eq!(watched[0]["directories"], json!([]));
    let sink = world.fake.sink.lock().clone().unwrap();
    let change =
        RunnerEventBody::WorkspaceChanged { path: "/repo".into(), change: "status".into() };
    sink(RunnerEvent::unsequenced(change));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(seen.lock().contains(&format!("{id}:work-status-changed")));
    let message = json!({ "type": "unsubscribe", "target": target });
    world.ctx.hub.receive(socket, &message.to_string());
    tokio::time::sleep(Duration::from_millis(300)).await;
    let watched = world.calls("setWatchedPaths");
    assert_eq!(watched.len(), 2);
    assert_eq!(watched[1]["workspaces"], json!([]));
    assert!(watched[1]["generation"].as_i64() > watched[0]["generation"].as_i64());
}
