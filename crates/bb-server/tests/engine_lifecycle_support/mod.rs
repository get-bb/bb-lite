#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use async_trait::async_trait;
use bb_core::{RunnerApi, RunnerResult, SharedRunner};
use bb_server::config::ServerConfig;
use bb_server::context::{Ctx, ServerContext};
use bb_server::db::threads::{ThreadRow, get_thread};
use bb_server::db::{Db, params};
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::runners::registry::RunnerRegistry;
use bb_server::ws::hub::Hub;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};

pub const HOST: &str = "host_a";

pub struct Fake {
    pub calls: Mutex<Vec<(String, Value)>>,
    pub instance_id: Mutex<String>,
    pub sessions: Mutex<Vec<Value>>,
    pub interrupted: Mutex<bool>,
}

impl Fake {
    pub fn methods(&self) -> Vec<String> {
        self.calls.lock().iter().map(|(method, _)| method.clone()).collect()
    }

    pub fn calls_to(&self, method: &str) -> Vec<Value> {
        let calls = self.calls.lock();
        calls.iter().filter(|(name, _)| name == method).map(|(_, params)| params.clone()).collect()
    }
}

#[async_trait]
impl RunnerApi for Fake {
    async fn call(&self, method: &str, params: Value) -> RunnerResult<Value> {
        self.calls.lock().push((method.to_owned(), params));
        Ok(match method {
            "describe" => json!({
                "instanceId": *self.instance_id.lock(),
                "version": "test",
                "hostName": "a",
                "platform": "linux",
                "homeDir": "/home",
                "dataDir": "/data",
                "threadStorageRoot": "/data/threads",
            }),
            "snapshot" => json!({
                "sessions": *self.sessions.lock(),
                "pendingRequestIds": [],
                "terminalIds": [],
                "lastEventSeq": 0,
            }),
            "interruptTurn" => json!({ "interrupted": *self.interrupted.lock() }),
            _ => json!({}),
        })
    }
}

pub struct World {
    pub ctx: Ctx,
    pub fake: Arc<Fake>,
    pub clock: Arc<AtomicI64>,
}

impl World {
    pub fn new() -> Self {
        let clock = Arc::new(AtomicI64::new(1_000));
        let now = clock.clone();
        let db = Db::open_in_memory(Some(Arc::new(move || now.load(Ordering::SeqCst)))).unwrap();
        db.run(
            "INSERT INTO hosts (id, name, created_at, updated_at) VALUES (?, 'a', 1, 1)",
            [HOST],
        )
        .unwrap();
        let project = "INSERT INTO projects (id, name, created_at, updated_at)
          VALUES ('prj', 'demo', 1, 1)";
        db.run(project, []).unwrap();
        let environment = "INSERT INTO environments (id, project_id, host_id, path,
          provider_owns_path, created_at, updated_at) VALUES ('env', 'prj', ?, '/w', 1, 1, 1)";
        db.run(environment, [HOST]).unwrap();
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
            instance_id: Mutex::new("inst_1".into()),
            sessions: Mutex::default(),
            interrupted: Mutex::new(true),
        });
        let world = Self { ctx, fake, clock };
        world.connect();
        world
    }

    pub fn connect(&self) {
        let runner = self.fake.clone();
        self.ctx.runners.connect(HOST, Box::new(move |_sink| runner as SharedRunner));
    }

    /// Inserts a thread on the test host's environment.
    pub fn thread(&self, id: &str, status: &str, parent: Option<&str>) {
        let sql = "INSERT INTO threads (id, project_id, environment_id, provider_id, status, title,
          parent_thread_id, latest_attention_at, created_at, updated_at)
          VALUES (?, 'prj', 'env', 'echo', ?, 'Build the widget', ?, 1, 1, 1)";
        self.ctx.db.run(sql, params![id, status, parent]).unwrap();
    }

    pub fn exec(&self, sql: &str, id: &str) {
        self.ctx.db.run(sql, [id]).unwrap();
    }

    pub fn row(&self, id: &str) -> Option<ThreadRow> {
        get_thread(&self.ctx.db, id).unwrap()
    }

    pub fn events(&self, id: &str) -> Vec<Value> {
        #[derive(Deserialize)]
        struct Event {
            data: String,
        }
        let sql = "SELECT data FROM events WHERE thread_id = ? ORDER BY sequence";
        let rows: Vec<Event> = self.ctx.db.all(sql, [id]).unwrap();
        rows.iter().map(|row| serde_json::from_str(&row.data).unwrap()).collect()
    }

    pub fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    pub async fn settle(&self) {
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
    }
}
