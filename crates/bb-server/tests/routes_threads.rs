use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use bb_server::config::ServerConfig;
use bb_server::context::{Ctx, ServerContext};
use bb_server::db::Db;
use bb_server::domain::changes::ChangedMessage;
use bb_server::http::routes::threads::thread_routes;
use bb_server::http::trust::Principal;
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::runners::registry::RunnerRegistry;
use bb_server::ws::hub::Hub;
use http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tower::ServiceExt;

fn context() -> Ctx {
    let dir = std::env::temp_dir();
    let config = ServerConfig {
        data_dir: dir.clone(),
        port: 0,
        bind_host: "127.0.0.1".into(),
        allowed_hosts: Vec::new(),
        app_dir: dir.clone(),
        cli_dir: dir.clone(),
        bb_cli_path: dir,
        version: "0.0.0".into(),
        host_id: "host_local".into(),
        log_level: LogLevel::Silent,
    };
    let db = Db::open_in_memory(None).unwrap();
    db.run("PRAGMA foreign_keys = OFF", []).unwrap();
    let hub = Hub::new();
    let log = Logger::silent();
    let plugins = PluginHost::new(PluginHostOptions {
        config: config.clone(),
        db: db.clone(),
        hub: hub.clone(),
        log: log.clone(),
        builtins: Some(Vec::new()),
    });
    Arc::new(ServerContext {
        config,
        db,
        hub,
        runners: RunnerRegistry::new("host_local", log.clone()),
        plugins,
        log,
        engine: Default::default(),
        environments: Default::default(),
        terminals: Default::default(),
    })
}

fn insert_thread(ctx: &Ctx, id: &str) {
    ctx.db
        .run(
            "INSERT INTO threads (id, project_id, provider_id, title, status, latest_attention_at, created_at, updated_at)
             VALUES (?, 'proj_demo', 'codex', 'Thread', 'idle', 1000, 1000, 1000)",
            [id],
        )
        .unwrap();
}

fn watch(ctx: &Ctx) -> (Arc<Mutex<Vec<Value>>>, impl Sized) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let guard = ctx.hub.on_changed(move |message: &ChangedMessage| {
        sink.lock().push(serde_json::to_value(message).unwrap());
    });
    (seen, guard)
}

async fn call(ctx: &Ctx, method: Method, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    let app: Router = thread_routes().with_state(ctx.clone());
    let mut request = Request::builder().method(method).uri(path);
    let body = match body {
        Some(body) => {
            request = request.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let mut request = request.body(body).unwrap();
    request.extensions_mut().insert(Principal::Owner);
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn changes_of(seen: &Mutex<Vec<Value>>, entity: &str, change: &str) -> Vec<Value> {
    seen.lock()
        .iter()
        .filter(|m| {
            m["entity"] == entity && m["changes"].as_array().unwrap().contains(&json!(change))
        })
        .cloned()
        .collect()
}

#[tokio::test]
async fn keeps_section_names_unique_and_unsections_threads_on_delete() {
    let ctx = context();
    let (seen, _guard) = watch(&ctx);
    let (status, later) =
        call(&ctx, Method::POST, "/thread-sections", Some(json!({ "name": " Later " }))).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(later["name"], "Later");
    assert_eq!(changes_of(&seen, "project", "threads-changed").len(), 1);
    let create = |name: &str| json!({ "name": name });
    assert_eq!(call(&ctx, Method::POST, "/thread-sections", Some(create("Later"))).await.0, 409);
    let (_, soon) = call(&ctx, Method::POST, "/thread-sections", Some(create("Soon"))).await;
    let rename = |id: &Value, name: &str| json!({ "id": id, "name": name });
    let (status, _) =
        call(&ctx, Method::PATCH, "/thread-sections", Some(rename(&soon["id"], "Later"))).await;
    assert_eq!(status, 409);
    let (status, _) =
        call(&ctx, Method::PATCH, "/thread-sections", Some(rename(&json!("sec_gone"), "N"))).await;
    assert_eq!(status, 404);
    let (status, renamed) =
        call(&ctx, Method::PATCH, "/thread-sections", Some(rename(&later["id"], "Someday"))).await;
    assert_eq!(status, 200);
    assert_eq!(renamed["name"], "Someday");
    assert_eq!(renamed["updatedThreadCount"], 0);
    assert_eq!(changes_of(&seen, "project", "threads-changed").len(), 3);
    insert_thread(&ctx, "thr_1");
    ctx.db.run("UPDATE threads SET section_id = ?", [later["id"].as_str().unwrap()]).unwrap();
    let body = json!({ "id": later["id"] });
    let (status, removed) = call(&ctx, Method::DELETE, "/thread-sections", Some(body)).await;
    assert_eq!(status, 200);
    assert_eq!(removed["updatedThreadCount"], 1);
    let titles = changes_of(&seen, "thread", "title-changed");
    assert_eq!(titles[0]["id"], "thr_1");
    assert_eq!(titles[0]["metadata"]["projectId"], "proj_demo");
    let projects: Vec<Value> = changes_of(&seen, "project", "threads-changed")[3..]
        .iter()
        .map(|m| m["id"].clone())
        .collect();
    assert_eq!(projects, vec![json!("proj_personal"), json!("proj_demo")]);
    let unsectioned: Vec<Value> =
        ctx.db.all("SELECT id FROM threads WHERE section_id IS NULL", []).unwrap();
    assert_eq!(unsectioned.len(), 1);
    let (_, list) = call(&ctx, Method::GET, "/thread-sections", None).await;
    let names: Vec<&Value> = list.as_array().unwrap().iter().map(|s| &s["name"]).collect();
    assert_eq!(names, vec![&json!("Soon")]);
}

#[tokio::test]
async fn section_requests_are_validated() {
    let ctx = context();
    for body in [json!({ "name": "   " }), json!({}), json!({ "name": "A", "extra": 1 })] {
        let (status, error) = call(&ctx, Method::POST, "/thread-sections", Some(body)).await;
        assert_eq!(status, 400);
        assert_eq!(error["code"], "invalid_request");
    }
    let (_, error) = call(&ctx, Method::POST, "/thread-sections", Some(json!({"name": " "}))).await;
    assert_eq!(error["message"], "Section name cannot be empty");
    let (status, _) = call(&ctx, Method::DELETE, "/thread-sections", Some(json!({"id": ""}))).await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn replaces_thread_tabs_only_at_the_expected_revision() {
    let ctx = context();
    let (seen, _guard) = watch(&ctx);
    insert_thread(&ctx, "thr_1");
    let (status, stored) = call(&ctx, Method::GET, "/threads/thr_1/tabs", None).await;
    assert_eq!(status, 200);
    assert_eq!(stored, json!({ "revision": 0, "tabs": [] }));
    let preview = json!({
        "path": "/etc/hosts", "lineRange": null, "hostId": null,
        "environmentId": null, "threadId": "thr_1", "id": "t2", "kind": "host-file-preview"
    });
    let diff = json!({ "id": "t1", "kind": "git-diff" });
    let body = json!({ "expectedRevision": 0, "tabs": [diff, preview] });
    let (status, wire) = call(&ctx, Method::PUT, "/threads/thr_1/tabs", Some(body)).await;
    assert_eq!(status, 200);
    assert!(!wire.to_string().contains("hostId"));
    let expected_preview = json!({
        "environmentId": null, "id": "t2", "kind": "host-file-preview",
        "lineRange": null, "path": "/etc/hosts", "threadId": "thr_1"
    });
    assert_eq!(wire, json!({ "revision": 1, "tabs": [diff, expected_preview] }));
    assert_eq!(changes_of(&seen, "thread", "tabs-changed")[0]["id"], "thr_1");
    let body = json!({ "expectedRevision": 0, "tabs": [] });
    let (status, conflict) = call(&ctx, Method::PUT, "/threads/thr_1/tabs", Some(body)).await;
    assert_eq!(status, 409);
    assert_eq!(conflict["code"], "thread_tabs_conflict");
    assert_eq!(conflict["details"], json!({ "currentRevision": 1 }));
    let (_, stored) = call(&ctx, Method::GET, "/threads/thr_1/tabs", None).await;
    assert_eq!(stored["tabs"].as_array().unwrap().len(), 2);
    assert_eq!(stored["tabs"][1], expected_preview);
    let (status, _) = call(&ctx, Method::GET, "/threads/thr_gone/tabs", None).await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn rejects_invalid_tabs() {
    let ctx = context();
    insert_thread(&ctx, "thr_1");
    let tab = json!({ "id": "t1", "kind": "git-diff" });
    let range = json!({ "startLineNumber": 5, "endLineNumber": 2 });
    let bad_preview = json!({
        "path": "/a", "lineRange": range, "environmentId": null, "threadId": null,
        "id": "t2", "kind": "host-file-preview"
    });
    for tabs in [
        json!([tab, tab]),
        json!([{ "id": "", "kind": "git-diff" }]),
        json!([{ "id": "t1", "kind": "nope" }]),
        json!([{ "id": "t1", "kind": "git-diff", "extra": true }]),
        json!([bad_preview]),
    ] {
        let body = json!({ "expectedRevision": 0, "tabs": tabs });
        let (status, error) = call(&ctx, Method::PUT, "/threads/thr_1/tabs", Some(body)).await;
        assert_eq!(status, 400, "{error}");
    }
    let body = json!({ "expectedRevision": 0, "tabs": [tab, tab] });
    let (_, error) = call(&ctx, Method::PUT, "/threads/thr_1/tabs", Some(body)).await;
    assert_eq!(error["message"], "Duplicate tab id: t1");
    let body = json!({ "expectedRevision": -1, "tabs": [] });
    assert_eq!(call(&ctx, Method::PUT, "/threads/thr_1/tabs", Some(body)).await.0, 400);
    let body = json!({ "expectedRevision": 0, "tabs": [] });
    assert_eq!(call(&ctx, Method::PUT, "/threads/thr_gone/tabs", Some(body)).await.0, 404);
}

#[tokio::test]
async fn validates_thread_write_requests_before_the_engine() {
    let ctx = context();
    let cases = [
        (
            Method::POST,
            "/threads",
            json!({ "projectId": "p", "origin": "plugin", "input": [{}], "environment": {} }),
            Some(r#"originPluginId is required when origin is "plugin""#),
        ),
        (
            Method::POST,
            "/threads",
            json!({ "projectId": "p", "origin": "user", "originPluginId": "x", "input": [{}], "environment": {} }),
            Some(r#"originPluginId requires origin "plugin""#),
        ),
        (
            Method::POST,
            "/threads",
            json!({ "projectId": "p", "origin": "user", "pluginMetadata": {}, "input": [{}], "environment": {} }),
            Some(r#"pluginMetadata requires origin "plugin""#),
        ),
        (
            Method::POST,
            "/threads",
            json!({ "projectId": "p", "origin": "plugin", "originPluginId": "Bad Id", "pluginMetadata": {}, "input": [{}], "environment": {} }),
            Some("pluginMetadata requires originPluginId to be a valid plugin id"),
        ),
        (
            Method::POST,
            "/threads",
            json!({ "projectId": "p", "origin": "user", "input": [], "environment": {} }),
            Some("input must contain at least one entry"),
        ),
        (
            Method::POST,
            "/threads",
            json!({ "projectId": "", "origin": "user", "input": [{}], "environment": {} }),
            None,
        ),
        (Method::PATCH, "/threads/thr_1", json!({}), Some("At least one field must be provided")),
        (Method::PATCH, "/threads/thr_1", json!({ "title": "" }), None),
        (Method::DELETE, "/threads/thr_1", json!({}), None),
        (Method::POST, "/threads/thr_1/send", json!({ "input": [], "mode": "auto" }), None),
        (Method::PATCH, "/threads/thr_1/pin-order", json!({ "previousThreadId": null }), None),
        (
            Method::PATCH,
            "/threads/thr_1/pin-order",
            json!({ "previousThreadId": "", "nextThreadId": null }),
            None,
        ),
        (Method::POST, "/threads/thr_1/queued-messages", json!({ "input": [] }), None),
        (
            Method::PATCH,
            "/threads/thr_1/queued-messages/q1",
            json!({ "expectedUpdatedAt": -1, "input": [{}] }),
            None,
        ),
        (Method::POST, "/threads/thr_1/queued-messages/q1/send", json!({ "mode": "later" }), None),
        (Method::POST, "/threads/thr_1/interactions/i1/respond", json!({}), None),
        (Method::POST, "/threads/thr_1/open", json!({ "split": "left" }), None),
        (Method::POST, "/threads/thr_1/open", json!({ "file": null, "extra": 1 }), None),
    ];
    for (method, path, body, message) in cases {
        let (status, error) = call(&ctx, method.clone(), path, Some(body)).await;
        assert_eq!(status, 400, "{method} {path}: {error}");
        assert_eq!(error["code"], "invalid_request");
        if let Some(message) = message {
            assert_eq!(error["message"], message);
        }
    }
    let big = "x".repeat(64 * 1024);
    let body = json!({ "value": big });
    let (status, error) =
        call(&ctx, Method::POST, "/threads/thr_1/interactions/i1/respond", Some(body)).await;
    assert_eq!(status, 413);
    assert_eq!(error["message"], "Interaction response exceeds 64 KiB");
}

#[tokio::test]
async fn open_delivers_to_sockets_and_guards_paths() {
    let ctx = context();
    let (status, _) =
        call(&ctx, Method::POST, "/threads/thr_gone/open", Some(json!({ "file": null }))).await;
    assert_eq!(status, 404);
    insert_thread(&ctx, "thr_1");
    let (status, body) =
        call(&ctx, Method::POST, "/threads/thr_1/open", Some(json!({ "file": null }))).await;
    assert_eq!((status, body), (StatusCode::OK, json!({ "delivered": 0 })));
    let file = json!({ "source": "workspace", "path": "a/../b", "lineNumber": null });
    let (status, error) =
        call(&ctx, Method::POST, "/threads/thr_1/open", Some(json!({ "file": file }))).await;
    assert_eq!(status, 400);
    assert_eq!(error["message"], "File path must stay inside its root.");
}
