#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

use async_trait::async_trait;
use bb_core::{
    RunnerApi, RunnerError, RunnerErrorCode, RunnerEvent, RunnerEventSink, RunnerResult,
};
use bb_server::config::ServerConfig;
use bb_server::context::{Ctx, ServerContext};
use bb_server::db::Db;
use bb_server::db::terminals::{NewTerminal, insert_terminal};
use bb_server::db::threads::{ThreadRow, get_thread};
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::builtin::{BuiltinPlugin, builtin_plugins};
use bb_server::plugins::deps::create_plugin_host_deps;
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::runners::registry::RunnerRegistry;
use bb_server::threads::create::CreateThreadRequest;
use bb_server::threads::engine::{self, ops};
use bb_server::ws::hub::{Hub, ListenerGuard};
use parking_lot::Mutex;
use serde_json::{Value, json};

pub const HOST: &str = "host_local";
pub const PROVIDER_THREAD: &str = "prov-1";

pub type Script = Arc<dyn Fn(&Value) -> RunnerResult<Value> + Send + Sync>;

#[derive(Default)]
pub struct Fake {
    pub calls: Mutex<Vec<(String, Value)>>,
    pub script: Mutex<HashMap<String, Script>>,
    pub submitted: Mutex<Vec<Value>>,
}

#[async_trait]
impl RunnerApi for Fake {
    async fn call(&self, method: &str, params: Value) -> RunnerResult<Value> {
        self.calls.lock().push((method.to_owned(), params.clone()));
        if method == "submitTurn" {
            self.submitted.lock().push(params.clone());
        }
        let script = self.script.lock().get(method).cloned();
        match script {
            Some(answer) => answer(&params),
            None => {
                Err(RunnerError::new(RunnerErrorCode::InvalidPath, format!("unscripted {method}")))
            }
        }
    }
}

fn scripted(value: Value) -> Script {
    Arc::new(move |_| Ok(value.clone()))
}

pub fn default_script() -> HashMap<String, Script> {
    let mut script: HashMap<String, Script> = HashMap::new();
    let started = json!({ "outcome": "started", "providerThreadId": PROVIDER_THREAD });
    let delivered = json!({ "delivered": true });
    let answers = [
        ("submitTurn", started),
        ("interruptTurn", json!({ "interrupted": true })),
        ("releaseSession", Value::Null),
        ("renameSession", Value::Null),
        ("resolveInteraction", delivered.clone()),
        ("resolveToolCall", delivered),
        ("deleteThreadStorage", Value::Null),
        ("closeTerminal", Value::Null),
        ("describe", json!({ "instanceId": "inst-1", "homeDir": "/home/me" })),
        ("snapshot", json!({ "sessions": [] })),
        ("listProviders", json!([{ "providerId": "codex", "installed": true }])),
        ("inspectGitSource", json!({ "defaultBranch": null, "originDefaultBranch": null })),
        ("inspectPath", json!({ "exists": true, "isGitRepo": false })),
        ("pathsExist", json!({ "existence": {} })),
    ];
    for (method, value) in answers {
        script.insert(method.to_owned(), scripted(value));
    }
    let worktree: Script = Arc::new(|params| {
        let key = params["key"].as_str().unwrap_or_default();
        let path = format!("/worktrees/{key}");
        Ok(json!({ "path": path, "mergeBaseBranch": "main", "worktreeInclude": null }))
    });
    script.insert("createWorktree".to_owned(), worktree);
    script
}

pub fn text(value: &str) -> Vec<Value> {
    vec![json!({ "type": "text", "text": value, "mentions": [] })]
}

fn turn(turn_id: &str) -> Value {
    json!({ "scope": { "kind": "turn", "turnId": turn_id }, "providerThreadId": PROVIDER_THREAD })
}

fn with(mut base: Value, extra: Value) -> Value {
    if let (Some(base), Value::Object(extra)) = (base.as_object_mut(), extra) {
        base.extend(extra);
    }
    base
}

pub mod events {
    use super::*;

    pub fn identity() -> Value {
        json!({
            "type": "thread/identity",
            "scope": { "kind": "thread" },
            "providerThreadId": PROVIDER_THREAD,
        })
    }

    pub fn started(turn_id: &str) -> Value {
        with(json!({ "type": "turn/started" }), turn(turn_id))
    }

    pub fn completed(turn_id: &str, status: &str) -> Value {
        with(json!({ "type": "turn/completed", "status": status }), turn(turn_id))
    }

    pub fn message(turn_id: &str, id: &str, reply: &str) -> Vec<Value> {
        let item = |text: &str| json!({ "type": "agentMessage", "id": id, "text": text });
        let mut batch =
            vec![with(json!({ "type": "item/started", "item": item("") }), turn(turn_id))];
        for part in reply.split(' ') {
            let delta = json!({ "type": "item/agentMessage/delta", "itemId": id, "delta": part });
            batch.push(with(delta, turn(turn_id)));
        }
        batch.push(with(json!({ "type": "item/completed", "item": item(reply) }), turn(turn_id)));
        batch
    }
}

pub struct Server {
    pub ctx: Ctx,
    pub fake: Arc<Fake>,
    pub clock: Arc<AtomicI64>,
    pub changes: Arc<Mutex<Vec<Value>>>,
    sink: Arc<Mutex<Option<RunnerEventSink>>>,
    seq: AtomicU64,
    _guard: ListenerGuard,
}

pub fn context(db: Db, log: Logger, builtins: Vec<BuiltinPlugin>) -> Ctx {
    let config = ServerConfig {
        data_dir: std::env::temp_dir().join("bb-e2e-lifecycle-data"),
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
    let plugins = PluginHost::new(PluginHostOptions {
        config: config.clone(),
        db: db.clone(),
        hub: hub.clone(),
        log: log.clone(),
        builtins: Some(builtins),
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
    ctx.plugins.set_deps(create_plugin_host_deps(&ctx));
    ctx
}

pub fn clocked_db(clock: &Arc<AtomicI64>) -> Db {
    let now = clock.clone();
    Db::open_in_memory(Some(Arc::new(move || now.load(Ordering::SeqCst)))).unwrap()
}

impl Server {
    pub async fn new() -> Self {
        Self::with_builtins(vec![]).await
    }

    /// A server whose plugin host loads the named builtin plugins.
    pub async fn with_plugins(names: &[&str]) -> Self {
        let wanted =
            |plugin: &BuiltinPlugin| names.iter().any(|name| plugin.directory.ends_with(name));
        let server =
            Self::with_builtins(builtin_plugins().into_iter().filter(wanted).collect()).await;
        server.ctx.plugins.reload(None).await.unwrap();
        server
    }

    async fn with_builtins(builtins: Vec<BuiltinPlugin>) -> Self {
        let clock = Arc::new(AtomicI64::new(1_000_000));
        let db = clocked_db(&clock);
        let seed = "INSERT INTO hosts (id, name, created_at, updated_at) VALUES (?1, 'h', 1, 1);
          INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj_1', 'P', 1, 1);
          INSERT INTO project_sources (id, project_id, host_id, path, created_at, updated_at)
            VALUES ('src_1', 'proj_1', ?1, '/repo', 1, 1);";
        for statement in seed.split(';').filter(|sql| !sql.trim().is_empty()) {
            let params: Vec<&str> = if statement.contains("?1") { vec![HOST] } else { vec![] };
            db.run(statement, rusqlite::params_from_iter(params)).unwrap();
        }
        let ctx = context(db, Logger::new(LogLevel::Warn), builtins);
        let changes = Arc::new(Mutex::new(Vec::new()));
        let recorded = changes.clone();
        let guard = ctx.hub.on_changed(move |message| {
            recorded.lock().push(serde_json::to_value(message).unwrap());
        });
        let fake = Arc::new(Fake { script: Mutex::new(default_script()), ..Default::default() });
        let server = Self {
            ctx,
            fake,
            clock,
            changes,
            sink: Arc::default(),
            seq: AtomicU64::new(0),
            _guard: guard,
        };
        engine::start(&server.ctx).unwrap();
        server.reconnect().await;
        server
    }

    pub fn script(
        &self,
        method: &str,
        answer: impl Fn(&Value) -> RunnerResult<Value> + Send + Sync + 'static,
    ) {
        self.fake.script.lock().insert(method.to_owned(), Arc::new(answer));
    }

    pub async fn reconnect(&self) {
        let (fake, sink) = (self.fake.clone(), self.sink.clone());
        self.ctx.runners.connect(
            HOST,
            Box::new(move |events| {
                *sink.lock() = Some(events);
                fake
            }),
        );
        self.settle().await;
    }

    pub async fn settle(&self) {
        for _ in 0..3 {
            tokio::task::yield_now().await;
        }
        engine::settled(&self.ctx).await;
    }

    pub async fn emit(&self, event: Value) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let event = with(json!({ "lane": "reliable", "seq": seq }), event);
        let event: RunnerEvent = serde_json::from_value(event).unwrap();
        let sink = self.sink.lock().clone().expect("runner connected");
        sink(event);
        self.settle().await;
    }

    pub async fn ingest(&self, thread_id: &str, batch: Vec<Value>) {
        self.emit(json!({ "kind": "thread.events", "threadId": thread_id, "events": batch })).await;
    }

    pub async fn run_turn(&self, thread_id: &str, turn_id: &str, reply: &str) {
        self.ingest(thread_id, vec![events::identity(), events::started(turn_id)]).await;
        let mut batch = events::message(turn_id, &format!("{turn_id}-i1"), reply);
        batch.push(events::completed(turn_id, "completed"));
        self.ingest(thread_id, batch).await;
    }

    pub async fn interact(
        &self,
        thread_id: &str,
        request_id: &str,
        payload: &Value,
        turn_id: &str,
    ) {
        self.emit(json!({
            "kind": "interaction.requested",
            "threadId": thread_id,
            "turnId": turn_id,
            "requestId": request_id,
            "providerId": "codex",
            "providerThreadId": PROVIDER_THREAD,
            "payload": payload,
        }))
        .await;
    }

    pub async fn spawn(&self, overrides: Value) -> String {
        let request = with(
            json!({
                "projectId": "proj_1",
                "origin": "app",
                "input": text("Please refactor the scheduler module today"),
                "model": "gpt-test",
                "environment": { "type": "project-default" },
                "startedOnBehalfOf": null,
            }),
            overrides,
        );
        let request: CreateThreadRequest = serde_json::from_value(request).unwrap();
        let created = ops::create(&self.ctx, request).await.unwrap();
        self.settle().await;
        created.thread.id.clone()
    }

    pub async fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
        ops::sweep(&self.ctx).unwrap();
        self.settle().await;
    }

    pub fn thread(&self, id: &str) -> ThreadRow {
        get_thread(&self.ctx.db, id).unwrap().unwrap()
    }

    pub fn rows(&self, sql: &str, params: &[&str]) -> Vec<Value> {
        let rows = self.ctx.db.rows(sql, rusqlite::params_from_iter(params)).unwrap();
        rows.into_iter().map(Value::Object).collect()
    }

    pub fn event_data(&self, thread_id: &str, kind: &str) -> Vec<Value> {
        let sql = "SELECT data FROM events WHERE thread_id = ? AND type LIKE ? ORDER BY sequence";
        let rows = self.rows(sql, &[thread_id, kind]);
        rows.iter()
            .map(|row| serde_json::from_str(row["data"].as_str().unwrap()).unwrap())
            .collect()
    }

    pub fn event_types(&self, thread_id: &str) -> Vec<String> {
        let sql = "SELECT type FROM events WHERE thread_id = ? ORDER BY sequence";
        let rows = self.rows(sql, &[thread_id]);
        rows.iter().map(|row| row["type"].as_str().unwrap().to_owned()).collect()
    }

    pub fn queued(&self, thread_id: &str) -> Vec<Value> {
        let sql = "SELECT json_extract(waiting_on, '$.kind') AS kind
          FROM queued_thread_messages WHERE thread_id = ? ORDER BY sort_key";
        self.rows(sql, &[thread_id]).into_iter().map(|row| row["kind"].clone()).collect()
    }

    pub fn calls_to(&self, method: &str) -> Vec<Value> {
        let calls = self.fake.calls.lock();
        calls.iter().filter(|(name, _)| name == method).map(|(_, params)| params.clone()).collect()
    }

    pub fn submitted(&self) -> Vec<Value> {
        self.fake.submitted.lock().clone()
    }

    pub fn open_terminal(&self, thread_id: &str) -> Value {
        let terminal = NewTerminal {
            thread_id: Some(thread_id.to_owned()),
            environment_id: None,
            host_id: HOST.to_owned(),
            title: "sh".into(),
            initial_cwd: "/repo".into(),
            cols: 80,
            rows: 24,
        };
        json!({ "terminalId": insert_terminal(&self.ctx.db, &terminal).unwrap().id })
    }

    /// Changed messages whose `changes` include `kind`, as `[changes, metadata]`.
    pub fn changed(&self, kind: &str) -> Vec<(Value, Value)> {
        let changes = self.changes.lock();
        let has = |message: &&Value| message["changes"].to_string().contains(kind);
        changes.iter().filter(has).map(|m| (m["changes"].clone(), m["metadata"].clone())).collect()
    }
}
