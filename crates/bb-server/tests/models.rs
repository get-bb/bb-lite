#![allow(clippy::result_large_err)]

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

use async_trait::async_trait;
use bb_core::{RunnerApi, RunnerError, RunnerErrorCode, RunnerResult, SharedRunner};
use bb_server::config::ServerConfig;
use bb_server::context::{Ctx, ServerContext};
use bb_server::db::Db;
use bb_server::domain::changes::ChangedMessage;
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::providers::models::*;
use bb_server::runners::registry::RunnerRegistry;
use bb_server::ws::hub::{Hub, ListenerGuard};
use parking_lot::Mutex;
use serde_json::{Value, json};

const HOST: &str = "host_a";

struct Fake {
    calls: AtomicUsize,
    fail: Mutex<bool>,
}

#[async_trait]
impl RunnerApi for Fake {
    async fn call(&self, method: &str, _params: Value) -> RunnerResult<Value> {
        assert_eq!(method, "listModels");
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        if *self.fail.lock() {
            let message = "codex\n  not   installed";
            return Err(RunnerError::new(RunnerErrorCode::parse("missing_executable"), message));
        }
        Ok(
            json!({ "models": [{ "model": format!("m{n}") }], "selectedOnlyModels": [{ "model": "hidden" }] }),
        )
    }
}

struct World {
    ctx: Ctx,
    clock: Arc<AtomicI64>,
    changes: Arc<Mutex<Vec<ChangedMessage>>>,
    _guard: ListenerGuard,
    _dir: tempfile::TempDir,
}

impl World {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(AtomicI64::new(1_000));
        let now = clock.clone();
        let db = Db::open_in_memory(Some(Arc::new(move || now.load(Ordering::SeqCst)))).unwrap();
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
        Self { ctx, clock, changes, _guard: guard, _dir: dir }
    }

    fn connect(&self) -> Arc<Fake> {
        let fake = Arc::new(Fake { calls: AtomicUsize::new(0), fail: Mutex::new(false) });
        let runner = fake.clone();
        self.ctx.runners.connect(HOST, Box::new(move |_| runner as SharedRunner));
        fake
    }
}

fn names(models: &[Value]) -> Vec<&str> {
    models.iter().filter_map(|m| m["model"].as_str()).collect()
}

#[tokio::test]
async fn caches_models_and_reports_offline_machines() {
    let world = World::new();
    let catalog = ModelCatalog::new(&world.ctx);
    let offline = catalog.read(&world.ctx, HOST, "codex").await;
    let error = offline.model_load_error.unwrap();
    assert_eq!(
        (error.code.as_str(), error.detail.as_deref()),
        ("failed", Some("Host is not connected"))
    );
    assert!(offline.models.is_empty());

    let fake = world.connect();
    let loaded = catalog.read(&world.ctx, HOST, "codex").await;
    assert_eq!(names(&loaded.models), ["m0"]);
    assert_eq!(names(&loaded.selected_only_models), ["hidden"]);
    assert_eq!(catalog.read(&world.ctx, HOST, "codex").await, loaded);
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);

    world.clock.fetch_add(10 * 60_000, Ordering::SeqCst);
    assert_eq!(names(&catalog.read(&world.ctx, HOST, "codex").await.models), ["m0"]);
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    assert_eq!(names(&catalog.read(&world.ctx, HOST, "codex").await.models), ["m1"]);
    let catalog_changed =
        world.changes.lock().iter().any(|m| matches!(m, ChangedMessage::Host { .. }));
    assert!(catalog_changed);

    let fake = world.connect();
    *fake.fail.lock() = true;
    let failed = catalog.read(&world.ctx, HOST, "codex").await;
    let error = failed.model_load_error.unwrap();
    assert_eq!(
        (error.code.as_str(), error.detail.as_deref()),
        ("missing_executable", Some("codex not installed"))
    );
    catalog.read(&world.ctx, HOST, "codex").await;
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    world.clock.fetch_add(30_000, Ordering::SeqCst);
    catalog.read(&world.ctx, HOST, "codex").await;
    assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn merges_custom_models_and_resolves_options() {
    let world = World::new();
    world.connect();
    let config = json!({ "customModels": [
        { "providerId": "codex", "model": "hidden" },
        { "providerId": "codex", "model": "mine", "displayName": "Mine" },
        { "providerId": "other", "model": "x" },
    ]});
    std::fs::write(world.ctx.config.data_dir.join("config.json"), config.to_string()).unwrap();
    let catalog = ModelCatalog::new(&world.ctx);
    let codex = EnabledProvider {
        id: "codex".into(),
        info: json!({"id": "codex"}),
        supported_reasoning_efforts: vec![json!("low")],
    };
    let query = ExecutionOptionsQuery { provider_id: Some("codex".into()), ..Default::default() };
    let response = resolve_execution_options(
        &world.ctx,
        &catalog,
        &query,
        std::slice::from_ref(&codex),
        |_| true,
    )
    .await
    .unwrap();
    assert_eq!(names(&response.loaded.models), ["m0", "hidden", "mine"]);
    assert!(response.loaded.selected_only_models.is_empty());
    assert_eq!(response.loaded.models[2]["displayName"], "Mine");
    assert_eq!(response.loaded.models[2]["supportedReasoningEfforts"], json!(["low"]));
    assert_eq!(response.providers, vec![json!({"id": "codex"})]);

    let unknown = ExecutionOptionsQuery { provider_id: Some("nope".into()), ..Default::default() };
    let error = resolve_execution_options(
        &world.ctx,
        &catalog,
        &unknown,
        std::slice::from_ref(&codex),
        |_| false,
    )
    .await
    .unwrap_err();
    assert_eq!(error.body.message, "Unsupported provider nope");
    let disabled =
        ExecutionOptionsQuery { provider_id: Some("claude".into()), ..Default::default() };
    let none = resolve_execution_options(&world.ctx, &catalog, &disabled, &[codex], |_| true)
        .await
        .unwrap();
    assert!(none.loaded.models.is_empty() && none.loaded.model_load_error.is_none());
}
