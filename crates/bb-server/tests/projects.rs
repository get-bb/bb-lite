#![allow(clippy::result_large_err)]

use std::sync::Arc;

use async_trait::async_trait;
use axum::Router;
use axum::body::{Body, to_bytes};
use bb_core::{RunnerApi, RunnerResult, SharedRunner};
use bb_server::config::ServerConfig;
use bb_server::context::{Ctx, ServerContext};
use bb_server::db::Db;
use bb_server::domain::changes::{ChangedMessage, ProjectChangeKind};
use bb_server::http::routes::projects::register_project_routes;
use bb_server::http::trust::Principal;
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::projects::attachments::canonical_project_attachment_path;
use bb_server::runners::registry::RunnerRegistry;
use bb_server::ws::hub::{Hub, ListenerGuard};
use http::{Request, StatusCode};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tower::ServiceExt;

const HOST: &str = "host_a";

struct Fake {
    calls: Mutex<Vec<(String, Value)>>,
}

#[async_trait]
impl RunnerApi for Fake {
    async fn call(&self, method: &str, params: Value) -> RunnerResult<Value> {
        self.calls.lock().push((method.to_owned(), params.clone()));
        Ok(match method {
            "inspectPath" => json!({
                "exists": true, "isGitRepo": true, "remoteUrl": "git@example.com:a/repo.git",
            }),
            _ => Value::Null,
        })
    }
}

struct World {
    ctx: Ctx,
    app: Router,
    changes: Arc<Mutex<Vec<ChangedMessage>>>,
    _guard: ListenerGuard,
    _dir: tempfile::TempDir,
}

impl World {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_in_memory(Some(Arc::new(|| 1_000))).unwrap();
        db.run(
            "INSERT INTO hosts (id, name, created_at, updated_at) VALUES (?, 'a', 1, 1)",
            [HOST],
        )
        .unwrap();
        bb_server::db::projects::ensure_personal_project(&db).unwrap();
        let config = ServerConfig {
            data_dir: dir.path().to_path_buf(),
            port: 0,
            bind_host: "127.0.0.1".into(),
            allowed_hosts: vec![],
            app_dir: Default::default(),
            cli_dir: Default::default(),
            bb_cli_path: Default::default(),
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
        let changes = Arc::new(Mutex::new(Vec::new()));
        let sink = changes.clone();
        let guard = ctx.hub.on_changed(move |message| sink.lock().push(message.clone()));
        let app = register_project_routes().with_state(ctx.clone());
        Self { ctx, app, changes, _guard: guard, _dir: dir }
    }

    fn connect(&self) -> Arc<Fake> {
        let fake = Arc::new(Fake { calls: Mutex::default() });
        let runner = fake.clone();
        self.ctx.runners.connect(HOST, Box::new(move |_| runner as SharedRunner));
        fake
    }

    async fn send(&self, request: Request<Body>) -> (StatusCode, Vec<u8>, http::HeaderMap) {
        let mut request = request;
        request.extensions_mut().insert(Principal::Owner);
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec();
        (status, body, headers)
    }

    async fn json(&self, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let builder = Request::builder().method(method).uri(uri);
        let request = match body {
            Some(body) => builder
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        };
        let (status, bytes, _) = self.send(request).await;
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    fn project_changes(&self) -> Vec<(String, Vec<ProjectChangeKind>)> {
        self.changes
            .lock()
            .drain(..)
            .filter_map(|message| match message {
                ChangedMessage::Project { id, changes } => Some((id, changes)),
                _ => None,
            })
            .collect()
    }

    async fn create(&self, path: &str) -> String {
        let body =
            json!({"name": "Repo", "source": {"hostId": HOST, "type": "local_path", "path": path}});
        let (status, project) = self.json("POST", "/projects", Some(body)).await;
        assert_eq!(status, StatusCode::CREATED, "{project}");
        project["id"].as_str().unwrap().to_owned()
    }

    async fn upload(&self, fields: &[(&str, Option<&str>, &str, &[u8])]) -> (StatusCode, Value) {
        let mut body = Vec::new();
        for (name, filename, content_type, bytes) in fields {
            body.extend_from_slice(b"--XBOUNDARY\r\n");
            let disposition = match filename {
                Some(file) => format!("form-data; name=\"{name}\"; filename=\"{file}\""),
                None => format!("form-data; name=\"{name}\""),
            };
            body.extend_from_slice(format!("Content-Disposition: {disposition}\r\n").as_bytes());
            if !content_type.is_empty() {
                body.extend_from_slice(format!("Content-Type: {content_type}\r\n").as_bytes());
            }
            body.extend_from_slice(b"\r\n");
            body.extend_from_slice(bytes);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(b"--XBOUNDARY--\r\n");
        let id = self
            .ctx
            .db
            .scalar::<String>("SELECT id FROM projects WHERE kind = 'standard' LIMIT 1", [])
            .unwrap()
            .unwrap();
        let request = Request::post(format!("/projects/{id}/attachments"))
            .header("content-type", "multipart/form-data; boundary=XBOUNDARY")
            .body(Body::from(body))
            .unwrap();
        let (status, bytes, _) = self.send(request).await;
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }
}

#[tokio::test]
async fn creates_lists_updates_and_deletes_projects() {
    let world = World::new();
    let fake = world.connect();
    let id = world.create("/work/repo/").await;
    assert_eq!(
        world.project_changes(),
        vec![(
            id.clone(),
            vec![ProjectChangeKind::ProjectCreated, ProjectChangeKind::ProjectSourcesChanged]
        )]
    );
    assert_eq!(fake.calls.lock()[0], ("inspectPath".into(), json!({"path": "/work/repo"})));
    let (_, project) = world.json("GET", &format!("/projects/{id}"), None).await;
    assert_eq!(project["gitRemoteUrl"], "git@example.com:a/repo.git");
    assert_eq!(project["sources"][0]["path"], "/work/repo");

    let again = world.create("/work/repo").await;
    assert_eq!(again, id);
    assert!(world.project_changes().is_empty());

    let (status, list) = world.json("GET", "/projects", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 1);
    let (_, list) = world.json("GET", "/projects?includePersonal=true", None).await;
    assert_eq!(list[0]["id"], "proj_personal");
    assert_eq!(list.as_array().unwrap().len(), 2);

    let (status, updated) =
        world.json("PATCH", &format!("/projects/{id}"), Some(json!({"name": "Renamed"}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["name"], "Renamed");
    assert_eq!(
        world.project_changes(),
        vec![(id.clone(), vec![ProjectChangeKind::ProjectUpdated])]
    );
    let (status, _) = world.json("PATCH", &format!("/projects/{id}"), Some(json!({}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, error) = world.json("DELETE", "/projects/proj_personal", None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["message"], "The personal project cannot be deleted");

    let (status, error) = world
        .json("POST", "/projects", Some(json!({"name": "x", "source": {"hostId": HOST, "type": "local_path", "path": "relative"}})))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["message"].as_str().unwrap().contains("Project path must be an absolute path."));
    let (status, _) = world
        .json("POST", "/projects", Some(json!({"name": "x", "source": {"hostId": "nope", "type": "local_path", "path": "/a"}})))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let attachments = world.ctx.config.data_dir.join("attachments").join(&id);
    std::fs::create_dir_all(&attachments).unwrap();
    let (status, ok) = world.json("DELETE", &format!("/projects/{id}"), None).await;
    assert_eq!((status, ok), (StatusCode::OK, json!({"ok": true})));
    assert!(!attachments.exists());
    assert_eq!(
        world.project_changes(),
        vec![(id.clone(), vec![ProjectChangeKind::ProjectDeleted])]
    );
    let left = world.ctx.db.rows("SELECT 1 FROM projects WHERE id = ?", [&id]).unwrap();
    assert!(left.is_empty());
}

#[tokio::test]
async fn manages_project_sources() {
    let world = World::new();
    world
        .ctx
        .db
        .run(
            "INSERT INTO hosts (id, name, created_at, updated_at) VALUES ('host_b', 'b', 1, 1)",
            [],
        )
        .unwrap();
    let id = world.create("/work/repo").await;
    world.project_changes();
    let (status, project) = world.json("GET", &format!("/projects/{id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(project["gitRemoteUrl"], Value::Null);

    let clone = json!({"hostId": "host_b", "type": "clone"});
    let (status, error) = world.json("POST", &format!("/projects/{id}/sources"), Some(clone)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["message"].as_str().unwrap().starts_with("Cloning a project onto a machine"));

    let body = json!({"hostId": "host_b", "type": "local_path", "path": "/b/repo"});
    let (status, source) =
        world.json("POST", &format!("/projects/{id}/sources"), Some(body.clone())).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(source["isDefault"], false);
    assert_eq!(
        world.project_changes(),
        vec![(id.clone(), vec![ProjectChangeKind::ProjectSourcesChanged])]
    );
    let (status, _) = world.json("POST", &format!("/projects/{id}/sources"), Some(body)).await;
    assert_eq!(status, StatusCode::CONFLICT);

    let source_id = source["id"].as_str().unwrap();
    let uri = format!("/projects/{id}/sources/{source_id}");
    let patch = json!({"type": "local_path", "isDefault": true, "path": "/b/moved"});
    let (status, updated) = world.json("PATCH", &uri, Some(patch)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        (updated["isDefault"].clone(), updated["path"].clone()),
        (json!(true), json!("/b/moved"))
    );
    let (status, _) = world.json("PATCH", &uri, Some(json!({"type": "local_path"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    world.project_changes();

    let (status, _) = world.json("DELETE", &uri, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        world.project_changes(),
        vec![(id.clone(), vec![ProjectChangeKind::ProjectSourcesChanged])]
    );
    let (status, error) = world.json("DELETE", &uri, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error["message"], "Project source not found");
}

#[tokio::test]
async fn uploads_and_serves_attachments() {
    let world = World::new();
    let id = world.create("/work/repo").await;
    let (status, uploaded) =
        world.upload(&[("file", Some("my photo.png"), "image/png", b"0123456789")]).await;
    assert_eq!(status, StatusCode::CREATED, "{uploaded}");
    assert_eq!(uploaded["type"], "localImage");
    assert_eq!(uploaded["name"], "my photo.png");
    assert_eq!(uploaded["mimeType"], "image/png");
    assert_eq!(uploaded["sizeBytes"], 10);
    let stored = uploaded["path"].as_str().unwrap().to_owned();
    assert!(stored.starts_with("my-photo-1000-") && stored.ends_with(".png"), "{stored}");

    let uri = format!("/projects/{id}/attachments/content?path={stored}");
    let (status, bytes, headers) =
        world.send(Request::get(&uri).body(Body::empty()).unwrap()).await;
    assert_eq!((status, bytes.as_slice()), (StatusCode::OK, &b"0123456789"[..]));
    assert_eq!(headers["content-type"], "image/png");
    assert_eq!(headers["cache-control"], "private, immutable, max-age=31536000");
    let ranged = Request::get(&uri).header("range", "bytes=2-4").body(Body::empty()).unwrap();
    let (status, bytes, _) = world.send(ranged).await;
    assert_eq!((status, bytes.as_slice()), (StatusCode::PARTIAL_CONTENT, &b"234"[..]));

    let missing = format!("/projects/{id}/attachments/content?path=nope.txt");
    let (status, error) = world.json("GET", &missing, None).await;
    assert_eq!(
        (status, error["message"].clone()),
        (StatusCode::NOT_FOUND, json!("Attachment not found"))
    );
    let escape = format!("/projects/{id}/attachments/content?path=../x");
    let (status, error) = world.json("GET", &escape, None).await;
    assert_eq!(
        (status, error["message"].clone()),
        (StatusCode::BAD_REQUEST, json!("Attachment path escapes project directory"))
    );

    let (status, file) = world.upload(&[("file", Some("notes"), "", b"x")]).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(file["type"], "localFile");
    assert!(file.get("mimeType").is_none());

    let refusal = "Attachment upload accepts exactly one multipart file field named \"file\"";
    let (status, error) = world.upload(&[("other", Some("a.txt"), "text/plain", b"x")]).await;
    assert_eq!((status, error["message"].clone()), (StatusCode::BAD_REQUEST, json!(refusal)));
    let two = [("file", Some("a.txt"), "text/plain", &b"x"[..]), ("note", None, "", &b"y"[..])];
    let (status, _) = world.upload(&two).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, error) = world.upload(&[("file", Some(" "), "text/plain", b"x")]).await;
    assert_eq!(error["message"], "Attachment filename is required");
    let (_, error) = world.upload(&[("file", Some("a.heic"), "image/heic", b"x")]).await;
    assert_eq!(
        error["message"],
        "HEIC images are not supported. Convert the image to JPEG or PNG before attaching it."
    );
    let big = vec![0u8; 35 * 1024 * 1024 + 200 * 1024];
    let (status, error) = world.upload(&[("file", Some("big.bin"), "", &big)]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["message"], "big.bin is 35.2MB, over the 35MB attachment limit");

    let (status, ok) = world
        .json(
            "POST",
            "/projects/proj_personal/attachments/copy",
            Some(json!({"sourceProjectId": id, "paths": [stored]})),
        )
        .await;
    assert_eq!((status, ok), (StatusCode::OK, json!({"ok": true})));
    let copied = format!("/projects/proj_personal/attachments/content?path={stored}");
    let (status, bytes, _) = world.send(Request::get(&copied).body(Body::empty()).unwrap()).await;
    assert_eq!((status, bytes.as_slice()), (StatusCode::OK, &b"0123456789"[..]));
    let rows = world.ctx.db.scalar::<i64>("SELECT count(*) FROM project_attachments", []).unwrap();
    assert_eq!(rows, Some(3));
}

#[test]
fn canonicalizes_attachment_paths() {
    assert_eq!(canonical_project_attachment_path("a/./b/../c.png").unwrap(), "a/c.png");
    assert_eq!(canonical_project_attachment_path("a\\b").unwrap(), "a/b");
    for path in ["/etc/passwd", "c:/x", "https://x", "..", "a/../../b"] {
        let error = canonical_project_attachment_path(path).unwrap_err();
        assert_eq!(error, "Attachment path escapes project directory", "{path}");
    }
    assert!(canonical_project_attachment_path("./").unwrap_err().contains("must refer to a file"));
    assert_eq!(
        canonical_project_attachment_path(".pending/x").unwrap_err(),
        "Attachment path is reserved for uploads"
    );
}
