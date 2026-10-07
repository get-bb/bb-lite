use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use axum::body::Body;
use axum::http::Request;
use bb_core::{RunnerApi, RunnerEventBody, RunnerResult};
use bb_remote::{Outbox, RunnerServing, memory_pair, serve_runner};
use bb_server::config::ServerConfig;
use bb_server::context::{Ctx, ServerContext};
use bb_server::db::Db;
use bb_server::db::hosts::{HostLookup, HostRow, NewHost, find_host, insert_host};
use bb_server::domain::host::MachinePhase;
use bb_server::http::routes::hosts::{register_host_routes, register_runner_routes};
use bb_server::http::trust::Principal;
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::runners::enrollment::{
    authenticate_runner, find_runner_host, hash_token, issue_join_token,
};
use bb_server::runners::registry::RunnerRegistry;
use bb_server::runners::remote::attach_remote_runner;
use bb_server::ws::hub::Hub;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tower::ServiceExt;

const LOCAL: &str = "host_local";

fn context(db: Db) -> Ctx {
    let config = ServerConfig {
        data_dir: PathBuf::from("/tmp/bb-runners-test"),
        port: 0,
        bind_host: "127.0.0.1".into(),
        allowed_hosts: vec![],
        app_dir: PathBuf::new(),
        cli_dir: PathBuf::new(),
        bb_cli_path: PathBuf::new(),
        version: "test".into(),
        host_id: LOCAL.into(),
        log_level: LogLevel::Silent,
    };
    let hub = Hub::new();
    let plugins = PluginHost::new(PluginHostOptions {
        config: config.clone(),
        db: db.clone(),
        hub: hub.clone(),
        log: Logger::silent(),
        builtins: Some(vec![]),
    });
    Arc::new(ServerContext {
        config,
        db,
        hub,
        runners: RunnerRegistry::new(LOCAL, Logger::silent()),
        plugins,
        log: Logger::silent(),
        engine: Default::default(),
        environments: Default::default(),
        terminals: Default::default(),
    })
}

fn clocked_db() -> (Db, Arc<AtomicI64>) {
    let clock = Arc::new(AtomicI64::new(1_000_000));
    let now = clock.clone();
    let db = Db::open_in_memory(Some(Arc::new(move || now.load(Ordering::SeqCst)))).unwrap();
    (db, clock)
}

fn add_host(ctx: &Ctx, id: &str, phase: MachinePhase) {
    let host =
        NewHost { id: id.into(), name: id.into(), phase, status_message: None, launch_key: None };
    insert_host(&ctx.db, &host).unwrap();
}

fn host(ctx: &Ctx, id: &str) -> HostRow {
    find_host(&ctx.db, HostLookup::Id, id).unwrap().unwrap()
}

async fn eventually(mut done: impl FnMut() -> bool) {
    for _ in 0..500 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("condition not reached");
}

struct FakeRunner {
    instance_id: String,
}

#[async_trait]
impl RunnerApi for FakeRunner {
    async fn call(&self, method: &str, _params: Value) -> RunnerResult<Value> {
        Ok(match method {
            "describe" => json!({
                "instanceId": self.instance_id,
                "version": "1.0.0",
                "platform": "linux",
                "threadStorageRoot": "/srv/threads",
            }),
            _ => Value::Null,
        })
    }
}

struct FakeMachine {
    outbox: Arc<Outbox>,
    serving: Arc<RunnerServing>,
}

impl FakeMachine {
    fn cancel(&self, request_id: &str) {
        self.outbox.emit(RunnerEventBody::InteractionCancelled {
            thread_id: "thr_1".into(),
            request_id: request_id.into(),
            reason: "test".into(),
        });
    }
}

fn dial(ctx: &Ctx, host_id: &str, instance_id: &str) -> FakeMachine {
    let (server_end, runner_end) = memory_pair();
    let slot: Arc<Mutex<Option<Arc<RunnerServing>>>> = Arc::default();
    let sink_slot = slot.clone();
    let outbox = Outbox::new(Arc::new(move |event| {
        if let Some(serving) = sink_slot.lock().as_ref() {
            serving.deliver(event);
        }
    }));
    let runner = Arc::new(FakeRunner { instance_id: instance_id.into() });
    let serving = Arc::new(serve_runner(runner, outbox.clone(), runner_end.socket));
    *slot.lock() = Some(serving.clone());
    attach_remote_runner(ctx, host_id, server_end.socket);
    FakeMachine { outbox, serving }
}

fn record_cancellations(ctx: &Ctx) -> Arc<Mutex<Vec<String>>> {
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let record = seen.clone();
    ctx.runners
        .on_event(
            "interaction.cancelled",
            Arc::new(move |event, _host| {
                if let RunnerEventBody::InteractionCancelled { request_id, .. } = event.body {
                    record.lock().push(request_id);
                }
                Box::pin(async { Ok(()) })
            }),
        )
        .forever();
    seen
}

#[tokio::test]
async fn attaches_describes_welcomes_and_persists_the_ack_cursor() {
    let ctx = context(Db::open_in_memory(None).unwrap());
    add_host(&ctx, "host_r", MachinePhase::Active);
    let seen = record_cancellations(&ctx);
    let machine = dial(&ctx, "host_r", "inst_1");
    eventually(|| ctx.runners.is_connected("host_r")).await;
    let row = host(&ctx, "host_r");
    assert_eq!(row.platform.as_deref(), Some("linux"));
    assert_eq!(row.thread_storage_root.as_deref(), Some("/srv/threads"));
    assert_eq!(row.last_instance_id.as_deref(), Some("inst_1"));
    assert!(row.last_seen_at.is_some());
    machine.cancel("a");
    machine.cancel("b");
    eventually(|| host(&ctx, "host_r").last_event_seq == 2).await;
    assert_eq!(*seen.lock(), vec!["a", "b"]);
    eventually(|| machine.outbox.last_acked_seq() == 2).await;
}

#[tokio::test]
async fn drops_reliable_events_already_delivered_for_the_same_instance() {
    let (db, _clock) = clocked_db();
    let ctx = context(db.clone());
    add_host(&ctx, "host_r", MachinePhase::Active);
    let seen = record_cancellations(&ctx);
    let first = dial(&ctx, "host_r", "inst_1");
    eventually(|| ctx.runners.is_connected("host_r")).await;
    first.cancel("a");
    eventually(|| host(&ctx, "host_r").last_event_seq == 1).await;
    first.serving.link().close(1000, "drop");
    eventually(|| !ctx.runners.is_connected("host_r")).await;

    let second = dial(&ctx, "host_r", "inst_1");
    eventually(|| ctx.runners.is_connected("host_r")).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    second.cancel("a-again");
    second.cancel("b");
    eventually(|| seen.lock().len() == 2).await;
    assert_eq!(*seen.lock(), vec!["a", "b"]);
    eventually(|| host(&ctx, "host_r").last_event_seq == 2).await;
    second.serving.link().close(1000, "drop");
    eventually(|| !ctx.runners.is_connected("host_r")).await;

    let restarted = context(db);
    let seen = record_cancellations(&restarted);
    let third = dial(&restarted, "host_r", "inst_1");
    eventually(|| restarted.runners.is_connected("host_r")).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    third.cancel("old-1");
    third.cancel("old-2");
    third.cancel("c");
    eventually(|| !seen.lock().is_empty()).await;
    assert_eq!(*seen.lock(), vec!["c"]);

    let fresh = dial(&restarted, "host_r", "inst_2");
    eventually(|| host(&restarted, "host_r").last_instance_id.as_deref() == Some("inst_2")).await;
    eventually(|| restarted.runners.is_connected("host_r")).await;
    fresh.cancel("d");
    eventually(|| seen.lock().len() == 2).await;
    assert_eq!(*seen.lock(), vec!["c", "d"]);
}

#[tokio::test]
async fn a_replacement_connection_closes_the_old_socket_with_4001() {
    let ctx = context(Db::open_in_memory(None).unwrap());
    add_host(&ctx, "host_r", MachinePhase::Active);
    let old = dial(&ctx, "host_r", "inst_1");
    eventually(|| ctx.runners.is_connected("host_r")).await;
    let old_link = old.serving.link().clone();
    let _new = dial(&ctx, "host_r", "inst_1");
    let code = tokio::time::timeout(Duration::from_secs(5), old_link.closed()).await.unwrap();
    assert_eq!(code, Some(4001));
    assert!(ctx.runners.is_connected("host_r"));
}

#[tokio::test]
async fn a_failed_handshake_closes_with_1011() {
    let ctx = context(Db::open_in_memory(None).unwrap());
    let machine = dial(&ctx, "host_missing", "inst_1");
    let link = machine.serving.link().clone();
    let code = tokio::time::timeout(Duration::from_secs(5), link.closed()).await.unwrap();
    assert_eq!(code, Some(1011));
    assert!(!ctx.runners.is_connected("host_missing"));
}

#[tokio::test]
async fn runner_tokens_are_stored_hashed_and_looked_up_by_bearer() {
    let ctx = context(Db::open_in_memory(None).unwrap());
    add_host(&ctx, "host_r", MachinePhase::Active);
    let token = "bbr_secret";
    let patch = bb_server::row! { "tokenHash" => hash_token(token).as_str() };
    bb_server::db::hosts::update_host(&ctx.db, "host_r", &patch).unwrap();
    assert_eq!(hash_token(token).len(), 64);
    assert_eq!(find_runner_host(&ctx.db, token).unwrap().unwrap().id, "host_r");
    assert!(find_runner_host(&ctx.db, "bbr_other").unwrap().is_none());
    let owner = Principal::Owner;
    let found = authenticate_runner(&ctx.db, Some("Bearer bbr_secret"), &owner).unwrap();
    assert_eq!(found.id, "host_r");
    let refused = authenticate_runner(&ctx.db, Some("Bearer  bbr_secret"), &owner).unwrap_err();
    assert_eq!(refused.code(), "invalid_runner_token");
    let other = Principal::Runner { connect_machine_id: Some("cm_other".into()) };
    let refused = authenticate_runner(&ctx.db, Some("Bearer bbr_secret"), &other).unwrap_err();
    assert_eq!(refused.status, 403);
}

async fn send(ctx: &Ctx, method: &str, uri: &str, body: Value, auth: Option<&str>) -> (u16, Value) {
    let app = register_host_routes()
        .merge(register_runner_routes())
        .layer(axum::Extension(Principal::Owner))
        .with_state(ctx.clone());
    let mut request = Request::builder().method(method).uri(uri);
    request = request.header("content-type", "application/json").header("host", "127.0.0.1:1");
    if let Some(auth) = auth {
        request = request.header("authorization", auth);
    }
    let body = if body.is_null() { Body::empty() } else { Body::from(body.to_string()) };
    let response = app.oneshot(request.body(body).unwrap()).await.unwrap();
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn creates_lists_renames_and_enrolls_machines() {
    let (db, clock) = clocked_db();
    let ctx = context(db);
    add_host(&ctx, LOCAL, MachinePhase::Active);
    let changes: Arc<Mutex<Vec<String>>> = Arc::default();
    let record = changes.clone();
    let _guard = ctx.hub.on_changed(move |message| {
        record.lock().push(serde_json::to_string(message).unwrap());
    });

    let create = json!({ "machineProviderId": "manual", "inputs": null, "key": "k1" });
    let (status, created) = send(&ctx, "POST", "/hosts", create.clone(), None).await;
    assert_eq!(status, 201);
    let id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(created["name"], format!("New machine {}", &id[id.len() - 6..]));
    assert_eq!(changes.lock().len(), 1);
    assert!(changes.lock()[0].contains("host-connected"));
    let (status, again) = send(&ctx, "POST", "/hosts", create, None).await;
    assert_eq!((status, again["id"].as_str()), (201, Some(id.as_str())));

    let bad = json!({ "machineProviderId": "modal", "inputs": null });
    let (status, error) = send(&ctx, "POST", "/hosts", bad, None).await;
    assert_eq!((status, error["code"].as_str()), (404, Some("machine_provider_not_found")));

    let (_, listed) = send(&ctx, "GET", "/hosts", Value::Null, None).await;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    let (_, listed) = send(&ctx, "GET", "/hosts?includeCreating=true", Value::Null, None).await;
    assert_eq!(listed.as_array().unwrap().len(), 2);

    let (status, detail) = send(&ctx, "GET", &format!("/hosts/{id}"), Value::Null, None).await;
    assert_eq!(status, 200);
    assert_eq!(detail["connectMachineId"], Value::Null);
    assert!(detail.get("threadStorageRootPath").is_some());
    let (status, _) = send(&ctx, "GET", "/hosts/host_nope", Value::Null, None).await;
    assert_eq!(status, 404);

    let rename = json!({ "name": "  Build box  " });
    let (status, renamed) = send(&ctx, "PATCH", &format!("/hosts/{id}"), rename, None).await;
    assert_eq!((status, renamed["name"].as_str()), (200, Some("Build box")));
    let ceiling = json!({ "maxPermissionMode": "accept-edits" });
    let uri = format!("/hosts/{id}/permission-ceiling");
    let (status, capped) = send(&ctx, "PATCH", &uri, ceiling, None).await;
    assert_eq!((status, capped["maxPermissionMode"].as_str()), (200, Some("accept-edits")));
    let (status, _) = send(&ctx, "PATCH", &uri, json!({ "maxPermissionMode": "x" }), None).await;
    assert_eq!(status, 400);
    let (status, _) =
        send(&ctx, "PATCH", &format!("/hosts/{id}"), json!({ "name": " " }), None).await;
    assert_eq!(status, 400);
    assert_eq!(changes.lock().len(), 3);

    let token = issue_join_token(&ctx.db, &id).unwrap();
    let bearer = format!("Bearer {}", token.join_token);
    assert!(token.join_token.starts_with("bbj_"));
    assert_eq!(host(&ctx, &id).join_token_hash, Some(hash_token(&token.join_token)));
    let join = json!({ "hostName": " worker " });
    let (status, credential) = send(&ctx, "POST", "/runner/join", join, Some(&bearer)).await;
    assert_eq!(status, 200);
    assert_eq!(credential["hostId"].as_str(), Some(id.as_str()));
    let runner_token = credential["runnerToken"].as_str().unwrap();
    assert!(runner_token.starts_with("bbr_"));
    let row = host(&ctx, &id);
    assert_eq!(row.name, "worker");
    assert_eq!(row.token_hash, Some(hash_token(runner_token)));
    assert_eq!(row.join_token_hash, None);
    let (status, error) = send(&ctx, "POST", "/runner/join", json!({}), Some(&bearer)).await;
    assert_eq!((status, error["code"].as_str()), (401, Some("invalid_join_token")));

    let expiring = issue_join_token(&ctx.db, &id).unwrap();
    clock.fetch_add(15 * 60_000, Ordering::SeqCst);
    let bearer = format!("Bearer {}", expiring.join_token);
    let (status, _) = send(&ctx, "POST", "/runner/join", Value::Null, Some(&bearer)).await;
    assert_eq!(status, 401);
    let (status, error) =
        send(&ctx, "POST", "/runner/join", json!({ "extra": 1 }), Some(&bearer)).await;
    assert_eq!((status, error["code"].as_str()), (400, Some("invalid_request")));
}
