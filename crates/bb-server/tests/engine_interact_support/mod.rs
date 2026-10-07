#![allow(dead_code)]

use std::sync::Arc;

use async_trait::async_trait;
use bb_core::{RunnerApi, RunnerResult, SharedRunner};
use bb_server::config::ServerConfig;
use bb_server::context::{Ctx, ServerContext};
use bb_server::db::threads::{ThreadRow, get_thread};
use bb_server::db::{Db, OnConflict, RowValues, insert_row};
use bb_server::domain::changes::{ChangedMessage, ThreadChangeKind, ThreadChangeMetadata};
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::row;
use bb_server::runners::registry::RunnerRegistry;
use bb_server::ws::hub::{Hub, ListenerGuard};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};

pub const HOST: &str = "host_local";

pub struct FakeState {
    pub calls: Vec<(String, Value)>,
    pub delivered: bool,
}

#[derive(Clone)]
pub struct FakeRunner(pub Arc<Mutex<FakeState>>);

#[async_trait]
impl RunnerApi for FakeRunner {
    async fn call(&self, method: &str, params: Value) -> RunnerResult<Value> {
        let mut state = self.0.lock();
        state.calls.push((method.to_owned(), params));
        Ok(match method {
            "resolveInteraction" => json!({ "delivered": state.delivered }),
            _ => Value::Null,
        })
    }
}

impl FakeRunner {
    pub fn calls(&self, method: &str) -> Vec<Value> {
        let state = self.0.lock();
        state.calls.iter().filter(|(name, _)| name == method).map(|(_, p)| p.clone()).collect()
    }
}

pub type Change = (String, Vec<ThreadChangeKind>, Option<ThreadChangeMetadata>);

pub struct Fixture {
    pub ctx: Ctx,
    pub runner: FakeRunner,
    pub changes: Arc<Mutex<Vec<Change>>>,
    _guard: ListenerGuard,
}

impl Fixture {
    pub fn changed(&self, kind: ThreadChangeKind) -> Vec<Option<ThreadChangeMetadata>> {
        let changes = self.changes.lock();
        changes.iter().filter(|(_, kinds, _)| kinds.contains(&kind)).map(|c| c.2.clone()).collect()
    }
}

pub fn fixture() -> Fixture {
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
        host_id: HOST.into(),
        log_level: LogLevel::Silent,
    };
    let db = Db::open_in_memory(None).unwrap();
    let at = |values: RowValues| values.set("createdAt", 1).set("updatedAt", 1);
    let host = row! { "id" => HOST, "name" => "Local" };
    insert_row(&db, "hosts", &at(host), OnConflict::Fail).unwrap();
    let project = row! { "id" => "proj_demo", "name" => "demo" };
    insert_row(&db, "projects", &at(project), OnConflict::Fail).unwrap();
    let env = row! {
        "id" => "env_demo", "projectId" => "proj_demo", "hostId" => HOST,
        "path" => "/work/demo", "status" => "ready",
    };
    insert_row(&db, "environments", &at(env), OnConflict::Fail).unwrap();
    let hub = Hub::new();
    let log = Logger::silent();
    let plugins = PluginHost::new(PluginHostOptions {
        config: config.clone(),
        db: db.clone(),
        hub: hub.clone(),
        log: log.clone(),
        builtins: Some(Vec::new()),
    });
    let ctx: Ctx = Arc::new(ServerContext {
        config,
        db,
        hub: hub.clone(),
        runners: RunnerRegistry::new(HOST, log.clone()),
        plugins,
        log,
        engine: Default::default(),
        environments: Default::default(),
        terminals: Default::default(),
    });
    let runner = FakeRunner(Arc::new(Mutex::new(FakeState { calls: Vec::new(), delivered: true })));
    let fake = runner.clone();
    ctx.runners.connect(HOST, Box::new(move |_sink| Arc::new(fake) as SharedRunner));
    let changes: Arc<Mutex<Vec<Change>>> = Arc::default();
    let seen = changes.clone();
    let guard = hub.on_changed(move |message| {
        if let ChangedMessage::Thread { id, changes, metadata } = message {
            seen.lock().push((id.clone(), changes.clone(), metadata.clone()));
        }
    });
    Fixture { ctx, runner, changes, _guard: guard }
}

pub fn seed(ctx: &Ctx, id: &str, extra: RowValues) -> ThreadRow {
    let mut values = row! {
        "id" => id, "projectId" => "proj_demo", "environmentId" => "env_demo",
        "providerId" => "codex", "status" => "idle", "latestAttentionAt" => 5, "createdAt" => 1, "updatedAt" => 1,
    };
    for key in extra.keys() {
        values.put(key, extra.get(key).unwrap().clone());
    }
    insert_row(&ctx.db, "threads", &values, OnConflict::Fail).unwrap();
    thread(ctx, id)
}

pub fn thread(ctx: &Ctx, id: &str) -> ThreadRow {
    get_thread(&ctx.db, id).unwrap().unwrap()
}

#[derive(Deserialize)]
struct EventRow {
    kind: String,
    data: String,
}

/// `(type, data)` of the thread's stored events in order.
pub fn events(ctx: &Ctx, id: &str) -> Vec<(String, Value)> {
    let sql = "SELECT type AS kind, data FROM events WHERE thread_id = ? ORDER BY sequence";
    let rows: Vec<EventRow> = ctx.db.all(sql, [id]).unwrap();
    rows.into_iter().map(|row| (row.kind, serde_json::from_str(&row.data).unwrap())).collect()
}

pub fn lifecycles(ctx: &Ctx, id: &str) -> Vec<Value> {
    events(ctx, id)
        .into_iter()
        .filter(|(kind, _)| kind == "system/interaction/lifecycle")
        .map(|(_, data)| data)
        .collect()
}
