#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use bb_core::{RunnerApi, RunnerEvent, RunnerEventSink, RunnerResult, SharedRunner};
use bb_server::config::ServerConfig;
use bb_server::context::{Ctx, ServerContext};
use bb_server::db::Db;
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::deps::create_plugin_host_deps;
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::runners::hosts::ensure_local_host;
use bb_server::runners::registry::{Registration, RunnerFactory, RunnerRegistry};
use bb_server::threads::create::CreateThreadRequest;
use bb_server::threads::engine::{self, ops};
use bb_server::threads::mutations::SendMessageRequest;
use bb_server::ws::hub::Hub;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::Notify;

pub const HOST: &str = "host_local";
pub const PROVIDER_THREAD: &str = "prov-1";

/// The scripted machine of `thread-harness.ts`: records every call and answers like its script.
#[derive(Default)]
pub struct Script {
    pub calls: Mutex<Vec<(String, Value)>>,
    pub submitted: Mutex<Vec<Value>>,
    pub refuse_interrupt: AtomicBool,
    pub gate: Mutex<Option<Arc<Notify>>>,
}

#[async_trait]
impl RunnerApi for Script {
    async fn call(&self, method: &str, params: Value) -> RunnerResult<Value> {
        self.calls.lock().push((method.to_owned(), params.clone()));
        if matches!(method, "inspectPath" | "inspectGitSource") {
            let gate = self.gate.lock().clone();
            if let Some(gate) = gate {
                gate.notified().await;
            }
        }
        Ok(match method {
            "submitTurn" => {
                self.submitted.lock().push(params);
                json!({ "outcome": "started", "providerThreadId": PROVIDER_THREAD })
            }
            "interruptTurn" => {
                json!({ "interrupted": !self.refuse_interrupt.load(Ordering::SeqCst) })
            }
            "resolveInteraction" | "resolveToolCall" => json!({ "delivered": true }),
            "describe" => json!({ "instanceId": "inst-1", "version": "test", "hostName": "me",
                "platform": "linux", "homeDir": "/home/me", "dataDir": "/data",
                "threadStorageRoot": "/data/threads" }),
            "snapshot" => json!({ "sessions": [], "pendingRequestIds": [], "terminalIds": [],
                "lastEventSeq": 0 }),
            "listProviders" => json!([{ "providerId": "codex", "installed": true }]),
            "inspectGitSource" => json!({ "defaultBranch": null, "originDefaultBranch": null }),
            "inspectPath" => json!({ "exists": true, "isGitRepo": false }),
            "createWorktree" => {
                let key = params["key"].as_str().unwrap_or_default();
                json!({ "path": format!("/worktrees/{key}"), "mergeBaseBranch": "main",
                    "worktreeInclude": null })
            }
            "pathsExist" => json!({ "existence": {} }),
            _ => Value::Null,
        })
    }
}

pub struct World {
    pub ctx: Ctx,
    pub clock: Arc<AtomicI64>,
    pub script: Arc<Script>,
    pub sink: Arc<Mutex<Option<RunnerEventSink>>>,
    pub logs: Arc<Mutex<Vec<String>>>,
    pub data_dir: Option<tempfile::TempDir>,
    seq: AtomicU64,
    _hosts: Vec<Registration>,
}

impl Drop for World {
    fn drop(&mut self) {
        let logs = self.logs.lock();
        if !logs.is_empty() {
            eprintln!("server log:\n{}", logs.join("\n"));
        }
        let failed = logs.iter().any(|line| line.contains(r#""level":"error""#));
        if failed && !std::thread::panicking() {
            panic!("the engine logged errors");
        }
    }
}

fn context(data_dir: PathBuf, clock: &Arc<AtomicI64>, logs: &Arc<Mutex<Vec<String>>>) -> Ctx {
    let now = clock.clone();
    let db = Db::open_in_memory(Some(Arc::new(move || now.load(Ordering::SeqCst)))).unwrap();
    let config = ServerConfig {
        data_dir,
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
    let collected = logs.clone();
    let log = Logger::with_writer(LogLevel::Warn, move |line| collected.lock().push(line.into()));
    let hub = Hub::new();
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
    ctx.plugins.set_deps(create_plugin_host_deps(&ctx));
    ctx
}

impl World {
    /// `createThreadServer()`: a project with a plain-directory source on the scripted host.
    pub fn new() -> Self {
        let clock = Arc::new(AtomicI64::new(1_000_000));
        let logs = Arc::default();
        let ctx = context(PathBuf::from("/nonexistent-bb-test"), &clock, &logs);
        let hosts = ensure_local_host(&ctx).unwrap();
        let world = Self {
            ctx,
            clock,
            script: Arc::default(),
            sink: Arc::default(),
            logs,
            data_dir: None,
            seq: AtomicU64::new(0),
            _hosts: hosts,
        };
        world.project("/repo");
        engine::start(&world.ctx).unwrap();
        world.connect();
        world
    }

    /// `createEchoServer()`: the real local runner with the echo adapter in a temp data dir.
    pub fn echo() -> (Self, PathBuf) {
        bb_server::providers::catalog::enable_dev_providers_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(AtomicI64::new(1_000_000));
        let logs = Arc::default();
        let ctx = context(dir.path().to_path_buf(), &clock, &logs);
        let hosts = ensure_local_host(&ctx).unwrap();
        let directory = dir.path().join("repo");
        std::fs::create_dir(&directory).unwrap();
        let world = Self {
            ctx,
            clock,
            script: Arc::default(),
            sink: Arc::default(),
            logs,
            data_dir: Some(dir),
            seq: AtomicU64::new(0),
            _hosts: hosts,
        };
        world.project(directory.to_str().unwrap());
        engine::start(&world.ctx).unwrap();
        let adapters = bb_runner::default_adapters();
        let (connect, _handle) =
            bb_server::runners::local::local_runner_for(&world.ctx.config, adapters);
        world.ctx.runners.connect(HOST, connect);
        (world, directory)
    }

    fn project(&self, path: &str) {
        let db = &self.ctx.db;
        let project = "INSERT INTO projects (id, name, created_at, updated_at)
          VALUES ('proj_1', 'P', 1, 1)";
        db.run(project, []).unwrap();
        let source = "INSERT INTO project_sources (id, project_id, host_id, path, created_at,
          updated_at) VALUES ('src_1', 'proj_1', ?, ?, 1, 1)";
        db.run(source, [HOST, path]).unwrap();
    }

    fn factory(&self) -> RunnerFactory {
        let script = self.script.clone();
        let slot = self.sink.clone();
        Box::new(move |sink| {
            *slot.lock() = Some(sink);
            script as SharedRunner
        })
    }

    pub fn connect(&self) {
        self.ctx.runners.connect(HOST, self.factory());
    }

    pub async fn reconnect(&self) {
        self.connect();
        self.settle().await;
    }

    pub async fn settle(&self) {
        tokio::task::yield_now().await;
        engine::settled(&self.ctx).await;
    }

    pub async fn emit(&self, mut event: Value) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        event["lane"] = json!("reliable");
        event["seq"] = json!(seq);
        let event: RunnerEvent = serde_json::from_value(event).unwrap();
        let sink = self.sink.lock().clone().expect("runner connected");
        sink(event);
        self.settle().await;
    }

    pub async fn ingest(&self, thread_id: &str, events: Vec<Value>) {
        self.emit(json!({ "kind": "thread.events", "threadId": thread_id, "events": events }))
            .await;
    }

    pub async fn interact(&self, thread_id: &str, request_id: &str, payload: Value, turn: &str) {
        let request = json!({
            "kind": "interaction.requested", "threadId": thread_id, "turnId": turn,
            "requestId": request_id, "providerId": "codex",
            "providerThreadId": PROVIDER_THREAD, "payload": payload,
        });
        self.emit(request).await;
    }

    pub async fn spawn_with(&self, overrides: Value, settles: bool) -> String {
        let mut request = json!({
            "projectId": "proj_1",
            "origin": "app",
            "input": text("Please refactor the scheduler module today"),
            "model": "gpt-test",
            "environment": { "type": "project-default" },
            "startedOnBehalfOf": null,
        });
        for (key, value) in overrides.as_object().cloned().unwrap_or_default() {
            request[key] = value;
        }
        let request: CreateThreadRequest = serde_json::from_value(request).unwrap();
        let created = ops::create(&self.ctx, request).await.map_err(|e| e.body).unwrap();
        if settles {
            self.settle().await;
        }
        created.thread.id
    }

    pub async fn spawn(&self) -> String {
        self.spawn_with(json!({}), true).await
    }

    /// `[status, delivery | details.reason | code, queuedMessage.waitingOn.kind]`.
    pub async fn send(&self, id: &str, mode: &str, message: &str, at: Option<i64>) -> Value {
        let request = json!({ "input": text(message), "mode": mode, "sendAt": at });
        let request: SendMessageRequest = serde_json::from_value(request).unwrap();
        let result = ops::send(&self.ctx, id, request).await;
        self.settle().await;
        let mut outcome = Vec::new();
        match result {
            Ok(response) => {
                let body = serde_json::to_value(response).unwrap();
                outcome.push(json!(200));
                outcome.push(body["delivery"].clone());
                let kind = &body["queuedMessage"]["waitingOn"]["kind"];
                if !kind.is_null() {
                    outcome.push(kind.clone());
                }
            }
            Err(error) => {
                outcome.push(json!(error.status));
                let reason = error.body.details.as_ref().map(|d| d["reason"].clone());
                outcome.push(reason.filter(|r| !r.is_null()).unwrap_or(json!(error.body.code)));
            }
        }
        Value::Array(outcome)
    }

    pub fn rows(&self, sql: &str, params: &[&str]) -> Vec<Map<String, Value>> {
        let params: Vec<String> = params.iter().map(|p| (*p).to_owned()).collect();
        self.ctx.db.rows(sql, rusqlite::params_from_iter(params)).unwrap()
    }

    pub fn thread(&self, id: &str) -> Map<String, Value> {
        self.rows("SELECT * FROM threads WHERE id = ?", &[id]).remove(0)
    }

    pub fn status(&self, id: &str) -> Value {
        self.thread(id)["status"].clone()
    }

    pub fn event_data(&self, id: &str, kind: &str) -> Vec<Value> {
        let sql = "SELECT data FROM events WHERE thread_id = ? AND type LIKE ? ORDER BY sequence";
        let rows = self.rows(sql, &[id, kind]);
        rows.iter()
            .map(|row| serde_json::from_str(row["data"].as_str().unwrap()).unwrap())
            .collect()
    }

    pub fn queued(&self, id: &str) -> Value {
        let sql = "SELECT json_extract(waiting_on, '$.kind') AS kind
          FROM queued_thread_messages WHERE thread_id = ? ORDER BY sort_key";
        Value::Array(self.rows(sql, &[id]).into_iter().map(|row| row["kind"].clone()).collect())
    }

    pub fn submitted(&self) -> Vec<Value> {
        self.script.submitted.lock().clone()
    }

    /// `[first input text, mode.kind]` of the last `submitTurn`.
    pub fn last_submit(&self) -> Value {
        let submitted = self.script.submitted.lock();
        let last = submitted.last().expect("a submitted turn");
        json!([last["input"][0]["text"], last["mode"]["kind"]])
    }

    pub fn calls_to(&self, method: &str) -> Vec<Value> {
        let calls = self.script.calls.lock();
        calls.iter().filter(|(name, _)| name == method).map(|(_, p)| p.clone()).collect()
    }

    pub async fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
        ops::sweep(&self.ctx).unwrap();
        self.settle().await;
    }

    /// Holds environment provisioning until the returned `Notify` is notified.
    pub fn defer_environment(&self) -> Arc<Notify> {
        let gate = Arc::new(Notify::new());
        *self.script.gate.lock() = Some(gate.clone());
        gate
    }

    pub async fn release(&self, gate: Arc<Notify>) {
        *self.script.gate.lock() = None;
        gate.notify_waiters();
        gate.notify_one();
        self.settle().await;
    }

    pub async fn run_turn(&self, id: &str, turn: &str) {
        self.ingest(id, vec![events::identity(), events::started(turn)]).await;
        let mut batch = events::message(turn, &format!("{turn}-i1"), "done");
        batch.push(events::completed(turn, "completed"));
        self.ingest(id, batch).await;
    }

    pub async fn wait_for(&self, what: &str, mut check: impl FnMut(&Self) -> bool) {
        for _ in 0..400 {
            if check(self) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("timed out waiting for {what}");
    }
}

pub fn text(value: &str) -> Value {
    json!([{ "type": "text", "text": value, "mentions": [] }])
}

pub mod events {
    use super::PROVIDER_THREAD;
    use serde_json::{Value, json};

    fn turn(kind: &str, turn_id: &str) -> Value {
        json!({ "type": kind, "scope": { "kind": "turn", "turnId": turn_id },
            "providerThreadId": PROVIDER_THREAD })
    }

    pub fn identity() -> Value {
        json!({ "type": "thread/identity", "scope": { "kind": "thread" },
            "providerThreadId": PROVIDER_THREAD })
    }

    pub fn started(turn_id: &str) -> Value {
        turn("turn/started", turn_id)
    }

    pub fn completed(turn_id: &str, status: &str) -> Value {
        let mut event = turn("turn/completed", turn_id);
        event["status"] = json!(status);
        event
    }

    pub fn message(turn_id: &str, id: &str, reply: &str) -> Vec<Value> {
        let item = |kind: &str, text: &str| {
            let mut event = turn(kind, turn_id);
            event["item"] = json!({ "type": "agentMessage", "id": id, "text": text });
            event
        };
        let mut batch = vec![item("item/started", "")];
        for part in reply.split(' ') {
            let mut delta = turn("item/agentMessage/delta", turn_id);
            delta["itemId"] = json!(id);
            delta["delta"] = json!(part);
            batch.push(delta);
        }
        batch.push(item("item/completed", reply));
        batch
    }
}
