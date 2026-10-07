use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use bb_server::config::ServerConfig;
use bb_server::context::{Ctx, ServerContext};
use bb_server::db::Db;
use bb_server::db::threads::{NewThread, ThreadRow, insert_thread};
use bb_server::domain::changes::{ChangedMessage, ThreadChangeKind};
use bb_server::domain::thread::ThreadVisibility;
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::runners::registry::RunnerRegistry;
use bb_server::ws::hub::{Hub, ListenerGuard};
use parking_lot::Mutex;

pub const HOST: &str = "host_a";
pub const PROJECT: &str = "prj";

pub struct Harness {
    pub ctx: Ctx,
    pub clock: Arc<AtomicI64>,
    pub changes: Arc<Mutex<Vec<ChangedMessage>>>,
    _listener: ListenerGuard,
}

impl Harness {
    pub fn new() -> Self {
        let clock = Arc::new(AtomicI64::new(1_000));
        let now = clock.clone();
        let db = Db::open_in_memory(Some(Arc::new(move || now.load(Ordering::SeqCst)))).unwrap();
        db.run(
            "INSERT INTO hosts (id, name, created_at, updated_at) VALUES (?, 'a', 1, 1)",
            [HOST],
        )
        .unwrap();
        let sql =
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, 'demo', 1, 1)";
        db.run(sql, [PROJECT]).unwrap();
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
        let changes: Arc<Mutex<Vec<ChangedMessage>>> = Arc::default();
        let sink = changes.clone();
        let listener = hub.on_changed(move |message| sink.lock().push(message.clone()));
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
        Self { ctx, clock, changes, _listener: listener }
    }

    pub fn thread(&self, parent: Option<&str>) -> ThreadRow {
        let thread = insert_thread(
            &self.ctx.db,
            NewThread {
                project_id: PROJECT.into(),
                provider_id: "echo".into(),
                model: Some("echo".into()),
                reasoning_level: Some("medium".into()),
                permission_mode: Some("full".into()),
                service_tier: Some("default".into()),
                title: None,
                title_fallback: None,
                section_id: None,
                startup_context: None,
                parent_thread_id: parent.map(str::to_owned),
                lifecycle_owner_thread_id: None,
                origin_plugin_id: None,
                visibility: ThreadVisibility::Visible,
                pinned: false,
            },
        )
        .unwrap();
        self.set(&thread.id, "status", "active");
        thread
    }

    pub fn set(&self, thread_id: &str, column: &str, value: &str) {
        let sql = format!("UPDATE threads SET {column} = ? WHERE id = ?");
        self.ctx.db.run(&sql, [value, thread_id]).unwrap();
    }

    pub fn tick(&self, millis: i64) {
        self.clock.fetch_add(millis, Ordering::SeqCst);
    }

    /// Thread change kinds announced for `thread_id` since the last call.
    pub fn take_thread_changes(&self, thread_id: &str) -> Vec<(ThreadChangeKind, Option<String>)> {
        let mut seen = Vec::new();
        for message in self.changes.lock().drain(..) {
            if let ChangedMessage::Thread { id, changes, metadata } = message
                && id == thread_id
            {
                let project = metadata.and_then(|metadata| metadata.project_id);
                seen.extend(changes.into_iter().map(|change| (change, project.clone())));
            }
        }
        seen
    }
}
