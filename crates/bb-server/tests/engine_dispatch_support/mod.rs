#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use async_trait::async_trait;
use bb_core::{RunnerApi, RunnerError, RunnerErrorCode, RunnerResult, SharedRunner};
use bb_server::config::ServerConfig;
use bb_server::context::{Ctx, ServerContext};
use bb_server::db::queued_messages::{QueuedMessageRow, list_queued_messages};
use bb_server::db::threads::{ThreadRow, get_thread};
use bb_server::db::{Db, params};
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::runners::registry::RunnerRegistry;
use bb_server::threads::dispatch::{DispatchArgs, OutboundMessage, SendMode};
use bb_server::threads::engine;
use bb_server::ws::hub::Hub;
use parking_lot::Mutex;
use serde_json::{Value, json};

pub const HOST: &str = "host_a";
pub const NOW: i64 = 1_000;

pub type Answer = Box<dyn Fn(&str, &Value) -> RunnerResult<Value> + Send + Sync>;

pub struct Fake {
    pub calls: Mutex<Vec<(String, Value)>>,
    pub answer: Mutex<Answer>,
}

#[async_trait]
impl RunnerApi for Fake {
    async fn call(&self, method: &str, params: Value) -> RunnerResult<Value> {
        self.calls.lock().push((method.to_owned(), params.clone()));
        (self.answer.lock())(method, &params)
    }
}

pub fn standard(method: &str, _params: &Value) -> RunnerResult<Value> {
    match method {
        "submitTurn" => Ok(json!({ "outcome": "started", "providerThreadId": "pt_1" })),
        "readFile" => Err(RunnerError::new(RunnerErrorCode::PathNotFound, "missing")),
        _ => Ok(json!({})),
    }
}

pub struct World {
    pub ctx: Ctx,
    pub fake: Arc<Fake>,
    pub clock: Arc<AtomicI64>,
}

impl World {
    pub fn new() -> Self {
        let clock = Arc::new(AtomicI64::new(NOW));
        let now = clock.clone();
        let db = Db::open_in_memory(Some(Arc::new(move || now.load(Ordering::SeqCst)))).unwrap();
        let hosts = "INSERT INTO hosts (id, name, created_at, updated_at) VALUES
          ('host_a', 'a', 1, 1), ('host_b', 'Laptop B', 1, 1)";
        db.run(hosts, []).unwrap();
        let project = "INSERT INTO projects (id, name, created_at, updated_at)
          VALUES ('prj', 'demo', 1, 1)";
        db.run(project, []).unwrap();
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
        let fake =
            Arc::new(Fake { calls: Mutex::default(), answer: Mutex::new(Box::new(standard)) });
        let runner = fake.clone();
        ctx.runners.connect(HOST, Box::new(move |_sink| runner as SharedRunner));
        Self { ctx, fake, clock }
    }

    pub fn environment(&self, id: &str, host_id: &str, status: &str, path: Option<&str>) {
        let sql = "INSERT INTO environments (id, project_id, host_id, path, status, created_at,
          updated_at) VALUES (?, 'prj', ?, ?, ?, 1, 1)";
        self.ctx.db.run(sql, params![id, host_id, path, status]).unwrap();
    }

    /// An echo thread on `environment_id` with the given status and active turn.
    pub fn thread(&self, id: &str, environment_id: Option<&str>, status: &str, turn: Option<&str>) {
        let sql = "INSERT INTO threads (id, project_id, environment_id, provider_id, status,
          active_turn_id, title, latest_attention_at, created_at, updated_at)
          VALUES (?, 'prj', ?, 'echo', ?, ?, 'Build the widget', 1, 1, 1)";
        self.ctx.db.run(sql, params![id, environment_id, status, turn]).unwrap();
    }

    pub fn ready_thread(&self, id: &str, status: &str, turn: Option<&str>) {
        self.environment("env_1", HOST, "ready", Some("/work"));
        self.thread(id, Some("env_1"), status, turn);
    }

    pub fn interaction(&self, thread_id: &str) {
        let sql = "INSERT INTO pending_interactions (id, thread_id, status, payload, created_at,
          updated_at) VALUES ('int_1', ?, 'pending', '{}', 1, 1)";
        self.ctx.db.run(sql, [thread_id]).unwrap();
    }

    pub fn get(&self, id: &str) -> ThreadRow {
        get_thread(&self.ctx.db, id).unwrap().unwrap()
    }

    pub fn queue(&self, id: &str) -> Vec<QueuedMessageRow> {
        list_queued_messages(&self.ctx.db, id).unwrap()
    }

    pub fn events(&self, id: &str) -> Vec<Value> {
        let sql = "SELECT type, data FROM events WHERE thread_id = ? ORDER BY sequence";
        let rows = self.ctx.db.rows(sql, [id]).unwrap();
        let event = |row: &serde_json::Map<String, Value>| {
            let mut data: Value = serde_json::from_str(row["data"].as_str().unwrap()).unwrap();
            data["type"] = row["type"].clone();
            data
        };
        rows.iter().map(event).collect()
    }

    pub fn calls(&self, method: &str) -> Vec<Value> {
        let calls = self.fake.calls.lock();
        calls.iter().filter(|(name, _)| name == method).map(|(_, params)| params.clone()).collect()
    }

    pub fn answer(&self, answer: Answer) {
        *self.fake.answer.lock() = answer;
    }

    pub async fn settled(&self) {
        engine::settled(&self.ctx).await;
    }
}

pub fn text(text: &str) -> Value {
    json!({ "type": "text", "text": text, "mentions": [] })
}

pub fn message(input: Vec<Value>) -> OutboundMessage {
    let execution = json!({
        "model": "echo-1",
        "reasoningLevel": "medium",
        "permissionMode": "full",
        "serviceTier": "default",
    });
    OutboundMessage {
        input,
        execution: serde_json::from_value(execution).unwrap(),
        sender_thread_id: None,
        initiator: "user".into(),
        system_notice: None,
    }
}

pub fn args(mode: SendMode, body: &str) -> DispatchArgs {
    DispatchArgs {
        message: message(vec![text(body)]),
        mode,
        send_at: None,
        rows: vec![],
        send_now: false,
    }
}
