#![allow(dead_code)]

pub mod fake_gate;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bb_server::config::ServerConfig;
use bb_server::db::Db;
use bb_server::error::ApiResult;
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::api::*;
use bb_server::plugins::builtin::{BuiltinPlugin, BuiltinServer, builtin_plugins};
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::plugins::native::connect::ConnectPlugin;
use bb_server::ws::hub::{Hub, HubSocket};
use parking_lot::Mutex;
use serde_json::{Value, json};

pub use fake_gate::{FakeGate, start_fake_gate};

/// The server's own host is `local`; any other host id is another machine.
struct Outward;

#[async_trait]
impl PluginOutward for Outward {
    async fn threads_spawn(&self, _: Value) -> ApiResult<Value> {
        Ok(Value::Null)
    }
    async fn threads_send(&self, _: &str, _: Value) -> ApiResult<Value> {
        Ok(Value::Null)
    }
    async fn threads_get(&self, _: &str) -> ApiResult<Option<Value>> {
        Ok(None)
    }
    async fn threads_list(&self, _: Value) -> ApiResult<Value> {
        Ok(json!({ "threads": [] }))
    }
    async fn threads_stop(&self, _: &str) -> ApiResult<()> {
        Ok(())
    }
    async fn threads_update(&self, _: &str, _: Value) -> ApiResult<Value> {
        Ok(Value::Null)
    }
    async fn threads_output(&self, _: &str) -> ApiResult<Option<String>> {
        Ok(None)
    }
    async fn threads_events(&self, _: &str, _: Option<i64>) -> ApiResult<Vec<Value>> {
        Ok(Vec::new())
    }
    async fn projects_list(&self) -> ApiResult<Value> {
        Ok(json!([]))
    }
    async fn hosts_list(&self) -> ApiResult<Value> {
        Ok(json!([
            { "id": "local", "machineProviderId": null },
            { "id": "laptop", "machineProviderId": "manual" },
        ]))
    }
    async fn sections_list(&self) -> ApiResult<Value> {
        Ok(json!([]))
    }
    async fn sections_create(&self, _: &str) -> ApiResult<Value> {
        Ok(Value::Null)
    }
    async fn files_read(&self, _: FileReadArgs) -> ApiResult<Option<FileRead>> {
        Ok(None)
    }
    async fn files_write(&self, _: FileWriteArgs) -> ApiResult<FileWriteOutcome> {
        Ok(FileWriteOutcome::Conflict)
    }
    async fn request_input(&self, _: InputRequest) -> InputResult {
        InputResult::Cancelled { reason: "test".into() }
    }
}

/// A realtime socket that keeps every message it receives.
#[derive(Default)]
pub struct Recorder(pub Mutex<Vec<Value>>);

impl HubSocket for Recorder {
    fn send(&self, data: String) -> bool {
        self.0.lock().push(serde_json::from_str(&data).unwrap_or(Value::String(data)));
        true
    }

    fn close(&self, _: u16, _: &str) {}
}

impl Recorder {
    /// Takes the plugin signals received so far.
    pub fn signals(&self) -> Vec<Value> {
        std::mem::take(&mut *self.0.lock())
    }
}

pub struct Harness {
    pub gate: Arc<FakeGate>,
    pub realtime: Arc<Recorder>,
    pub host: PluginHost,
    pub temp: tempfile::TempDir,
}

/// A plugin host with only the connect builtin, pointed at a fresh fake gate. With `linked`,
/// the gate's link is written to `connect.json` first, as server.test.ts does.
pub async fn harness(linked: bool) -> Harness {
    let gate = start_fake_gate().await;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let entry = builtin_plugins().into_iter().find(|p| p.directory.ends_with("connect")).unwrap();
    assert!(matches!(entry.server, BuiltinServer::Native(_)));
    let connect = Arc::new(ConnectPlugin::with_base_url(gate.apex_url.clone()));
    let builtin =
        BuiltinPlugin { directory: entry.directory, server: BuiltinServer::Native(connect) };
    let config = ServerConfig {
        data_dir: root.join("data"),
        port: 0,
        bind_host: "127.0.0.1".into(),
        allowed_hosts: Vec::new(),
        app_dir: root.join("app"),
        cli_dir: root.join("cli"),
        bb_cli_path: root.join("bb"),
        version: "0.0.0".into(),
        host_id: "local".into(),
        log_level: LogLevel::Silent,
    };
    std::fs::create_dir_all(root.join("data")).unwrap();
    if linked {
        let link = serde_json::to_string(&gate.link()).unwrap();
        std::fs::write(root.join("data/connect.json"), link).unwrap();
    }
    let hub = Hub::new();
    let realtime = Arc::new(Recorder::default());
    hub.connect(realtime.clone());
    let host = PluginHost::new(PluginHostOptions {
        config,
        db: Db::open_in_memory(None).unwrap(),
        hub,
        log: Logger::silent(),
        builtins: Some(vec![builtin]),
    });
    host.set_deps(Arc::new(|_: &str| Arc::new(Outward) as Arc<dyn PluginOutward>));
    host.reload(None).await.unwrap();
    host.running("connect").unwrap();
    Harness { gate, realtime, host, temp }
}

impl Harness {
    pub async fn cli_in(&self, thread_id: Option<&str>, argv: &[&str]) -> CliResult {
        let cli = self.host.running("connect").unwrap().cli().unwrap();
        let context = CliContext {
            cwd: Some(self.temp.path().to_string_lossy().into_owned()),
            thread_id: thread_id.map(str::to_owned),
            ..CliContext::default()
        };
        cli.run(argv.iter().map(|arg| arg.to_string()).collect(), context).await
    }

    pub async fn cli(&self, argv: &[&str]) -> CliResult {
        self.cli_in(Some("thr_1"), argv).await
    }

    pub async fn rpc(&self, method: &str, input: Value) -> Result<Value, RpcFailure> {
        let handler = self.host.running("connect").unwrap().rpc(method).unwrap();
        handler.call(input).await
    }

    pub async fn status(&self) -> Value {
        self.rpc("status", Value::Null).await.unwrap()
    }

    /// Waits up to ten seconds for the status to satisfy `done`.
    pub async fn wait_for(&self, done: impl Fn(&Value) -> bool) -> Value {
        for _ in 0..1000 {
            let status = self.status().await;
            if done(&status) {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("status never matched: {}", self.status().await);
    }

    pub async fn connected(&self) -> Value {
        self.wait_for(|status| status["state"] == "connected").await
    }

    pub fn context(&self, thread_id: &str, host_id: Option<&str>) -> ThreadContext {
        ThreadContext {
            thread_id: thread_id.into(),
            project_id: "p1".into(),
            host_id: host_id.map(str::to_owned),
            provider_id: "codex".into(),
            provider_capabilities: None,
        }
    }
}
