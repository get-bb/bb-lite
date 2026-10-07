//! One loaded plugin: everything it registered, and the API object it
//! registered through. The port of `apps/server/src/plugins/instance.ts`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::api::*;
use super::settings::PluginSettings;
use crate::db::Db;
use crate::db::plugins::{PluginRowTable, read_plugin_rows, write_plugin_row};
use crate::domain::changes::SystemChangeKind;
use crate::error::{ApiError, ApiResult};
use crate::log::Logger;
use crate::ws::hub::Hub;

const KV_VALUE_MAX_BYTES: usize = 256 * 1024;
const SERVICE_RESTART_BASE_MS: u64 = 1_000;
const SERVICE_HEALTHY_MS: u64 = 60_000;
const MIGRATIONS_TABLE: &str = "CREATE TABLE IF NOT EXISTS _bb_migrations
  (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, statement_hash TEXT)";

/// What the plugin host gives every instance.
#[derive(Clone)]
pub struct PluginApiHost {
    pub db: Db,
    pub hub: Hub,
    pub log: Logger,
    pub data_dir: PathBuf,
    pub server_url: String,
    pub deps: PluginHostDeps,
}

#[derive(Clone)]
pub struct PluginLog {
    log: Logger,
    plugin_id: String,
}

impl PluginLog {
    fn fields(&self) -> Value {
        json!({ "pluginId": self.plugin_id })
    }

    pub fn debug(&self, message: &str) {
        self.log.debug(message, self.fields());
    }

    pub fn info(&self, message: &str) {
        self.log.info(message, self.fields());
    }

    pub fn warn(&self, message: &str) {
        self.log.warn(message, self.fields());
    }

    pub fn error(&self, message: &str) {
        self.log.error(message, self.fields());
    }
}

#[derive(Clone)]
pub struct HttpRoute {
    pub handler: Arc<dyn HttpHandler>,
    pub auth: HttpAuth,
}

#[derive(Default)]
struct Registrations {
    rpc: IndexMap<String, Arc<dyn RpcHandler>>,
    routes: IndexMap<String, HttpRoute>,
    cli: Option<Arc<dyn PluginCli>>,
    tools: Vec<Arc<dyn AgentTool>>,
    instructions: Vec<InstructionsContributor>,
    env: Vec<(String, EnvContributor)>,
    mention_providers: Vec<Arc<dyn MentionProvider>>,
    environments: Vec<EnvironmentDefinition>,
    inference: Vec<Arc<dyn InferenceService>>,
    listeners: Vec<(String, EventListener)>,
    services: Vec<(String, BackgroundService)>,
    disposers: Vec<Disposer>,
    needs_configuration: Option<String>,
    public_url: Option<String>,
    machine_access: Option<Arc<dyn MachineAccessProvider>>,
}

pub struct PluginInstance {
    pub plugin_id: String,
    pub settings: Arc<PluginSettings>,
    pub log: PluginLog,
    pub stopping: CancellationToken,
    registered: Mutex<Registrations>,
}

impl PluginInstance {
    pub fn rpc(&self, method: &str) -> Option<Arc<dyn RpcHandler>> {
        self.registered.lock().rpc.get(method).cloned()
    }

    /// `key` is `"METHOD /path"`.
    pub fn route(&self, key: &str) -> Option<HttpRoute> {
        self.registered.lock().routes.get(key).cloned()
    }

    pub fn cli(&self) -> Option<Arc<dyn PluginCli>> {
        self.registered.lock().cli.clone()
    }

    pub fn tools(&self) -> Vec<Arc<dyn AgentTool>> {
        self.registered.lock().tools.clone()
    }

    pub fn instructions(&self) -> Vec<InstructionsContributor> {
        self.registered.lock().instructions.clone()
    }

    pub fn env(&self) -> Vec<(String, EnvContributor)> {
        self.registered.lock().env.clone()
    }

    pub fn mention_providers(&self) -> Vec<Arc<dyn MentionProvider>> {
        self.registered.lock().mention_providers.clone()
    }

    pub fn environments(&self) -> Vec<EnvironmentDefinition> {
        self.registered.lock().environments.clone()
    }

    pub fn inference(&self) -> Vec<Arc<dyn InferenceService>> {
        self.registered.lock().inference.clone()
    }

    pub fn listeners(&self, name: &str) -> Vec<EventListener> {
        let registered = self.registered.lock();
        let matching = registered.listeners.iter().filter(|(listened, _)| listened == name);
        matching.map(|(_, handler)| handler.clone()).collect()
    }

    pub fn needs_configuration(&self) -> Option<String> {
        self.registered.lock().needs_configuration.clone()
    }

    pub fn public_url(&self) -> Option<String> {
        self.registered.lock().public_url.clone()
    }

    pub fn machine_access(&self) -> Option<Arc<dyn MachineAccessProvider>> {
        self.registered.lock().machine_access.clone()
    }

    pub fn start_services(self: &Arc<Self>) {
        let services = self.registered.lock().services.clone();
        for (name, service) in services {
            tokio::spawn(self.clone().supervise(name, service));
        }
    }

    /// Cancels services, then runs the dispose hooks, last registered first.
    pub async fn dispose(&self) {
        self.stopping.cancel();
        let disposers = std::mem::take(&mut self.registered.lock().disposers);
        for dispose in disposers.into_iter().rev() {
            dispose().await;
        }
    }

    async fn supervise(self: Arc<Self>, name: String, service: BackgroundService) {
        let signal = self.stopping.clone();
        let mut crashes: u32 = 0;
        while !signal.is_cancelled() {
            let started_at = Instant::now();
            let Err(error) = service(signal.clone()).await else { return };
            if signal.is_cancelled() {
                return;
            }
            if started_at.elapsed() >= Duration::from_millis(SERVICE_HEALTHY_MS) {
                crashes = 0;
            }
            let delay = SERVICE_RESTART_BASE_MS * 2u64.pow(crashes.min(6));
            self.log.warn(&format!("service {name} crashed, restarting: {error}"));
            tokio::select! {
                () = signal.cancelled() => return,
                () = tokio::time::sleep(Duration::from_millis(delay)) => {}
            }
            crashes += 1;
        }
    }
}

/// The plugin's rows in `plugin_kv`.
#[derive(Clone)]
pub struct PluginKv {
    db: Db,
    plugin_id: String,
}

impl PluginKv {
    pub fn get(&self, key: &str) -> ApiResult<Option<Value>> {
        let rows = read_plugin_rows(&self.db, PluginRowTable::PluginKv, &self.plugin_id, key)?;
        Ok(rows.get(key).map(|text| serde_json::from_str(text)).transpose()?)
    }

    pub fn set(&self, key: &str, value: &Value) -> ApiResult<()> {
        let text = value.to_string();
        if text.encode_utf16().count() > KV_VALUE_MAX_BYTES {
            let message = format!("KV value for \"{key}\" is not JSON under 256 KiB");
            return Err(ApiError::internal(message));
        }
        Ok(write_plugin_row(&self.db, PluginRowTable::PluginKv, &self.plugin_id, key, Some(&text))?)
    }

    pub fn delete(&self, key: &str) -> ApiResult<()> {
        Ok(write_plugin_row(&self.db, PluginRowTable::PluginKv, &self.plugin_id, key, None)?)
    }

    pub fn list(&self, prefix: Option<&str>) -> ApiResult<Vec<String>> {
        let table = PluginRowTable::PluginKv;
        let rows = read_plugin_rows(&self.db, table, &self.plugin_id, prefix.unwrap_or(""))?;
        Ok(rows.into_keys().collect())
    }
}

#[derive(Clone)]
pub struct SettingsHandle {
    settings: Arc<PluginSettings>,
    log: PluginLog,
}

impl SettingsHandle {
    pub async fn get(&self) -> ApiResult<SettingRecord> {
        self.settings.read().await
    }

    pub async fn set(&self, values: &IndexMap<String, Value>) -> ApiResult<SettingRecord> {
        self.settings.write(values).await
    }

    pub fn on_change(&self, listener: SettingsListener) {
        let _ = &self.log;
        self.settings.on_change(listener);
    }
}

/// The object a plugin entry receives (`bb` in the TypeScript API).
#[derive(Clone)]
pub struct PluginApi {
    pub plugin_id: String,
    pub log: PluginLog,
    /// The plugin's own directory, `<dataDir>/plugins/<id>`.
    pub data_dir: PathBuf,
    /// The server's loopback URL.
    pub server_url: String,
    pub server_data_dir: PathBuf,
    pub outward: Arc<dyn PluginOutward>,
    instance: Arc<PluginInstance>,
    db: Db,
    hub: Hub,
}

impl PluginApi {
    pub fn settings_define(&self, descriptors: SettingDescriptors) -> SettingsHandle {
        self.instance.settings.define(descriptors);
        SettingsHandle { settings: self.instance.settings.clone(), log: self.log.clone() }
    }

    pub fn kv(&self) -> PluginKv {
        PluginKv { db: self.db.clone(), plugin_id: self.plugin_id.clone() }
    }

    /// Where the plugin's private SQLite database lives. The plugin opens it
    /// itself (WAL, `busy_timeout = 5000`) and closes it in a dispose hook.
    pub fn database_path(&self) -> PathBuf {
        self.data_dir.join("data.db")
    }

    pub fn rpc_register(&self, method: &str, handler: Arc<dyn RpcHandler>) {
        self.instance.registered.lock().rpc.insert(method.to_owned(), handler);
    }

    pub fn http_route(
        &self,
        method: &str,
        path: &str,
        auth: HttpAuth,
        handler: Arc<dyn HttpHandler>,
    ) {
        let key = format!("{} {path}", method.to_uppercase());
        self.instance.registered.lock().routes.insert(key, HttpRoute { handler, auth });
    }

    /// Returns how many connected clients received the signal.
    pub fn realtime_publish(&self, channel: &str, payload: Value) -> usize {
        self.hub.plugin_signal(&self.plugin_id, channel, payload)
    }

    pub fn background_service(&self, name: &str, service: BackgroundService) {
        self.instance.registered.lock().services.push((name.to_owned(), service));
    }

    pub fn cli_register(&self, cli: Arc<dyn PluginCli>) -> PluginResult<()> {
        let mut registered = self.instance.registered.lock();
        if registered.cli.is_some() {
            return Err(PluginError::new("A plugin has one CLI"));
        }
        registered.cli = Some(cli);
        Ok(())
    }

    pub fn events_on(&self, name: &str, listener: EventListener) {
        self.instance.registered.lock().listeners.push((name.to_owned(), listener));
    }

    pub fn register_tool(&self, tool: Arc<dyn AgentTool>) {
        self.instance.registered.lock().tools.push(tool);
    }

    pub fn contribute_instructions(&self, contribute: InstructionsContributor) {
        self.instance.registered.lock().instructions.push(contribute);
    }

    pub async fn request_input(&self, request: InputRequest) -> InputResult {
        self.outward.request_input(request).await
    }

    pub fn register_mention_provider(&self, provider: Arc<dyn MentionProvider>) {
        self.instance.registered.lock().mention_providers.push(provider);
    }

    pub fn contribute_env(&self, provider_id: &str, contribute: EnvContributor) {
        self.instance.registered.lock().env.push((provider_id.to_owned(), contribute));
    }

    pub fn register_environment(&self, definition: EnvironmentDefinition) {
        self.instance.registered.lock().environments.push(definition);
    }

    pub fn register_inference(&self, service: Arc<dyn InferenceService>) {
        self.instance.registered.lock().inference.push(service);
    }

    pub fn needs_configuration(&self, message: &str) {
        self.instance.registered.lock().needs_configuration = Some(message.to_owned());
        self.hub.system(vec![SystemChangeKind::PluginsChanged]);
    }

    pub fn set_machine_access_provider(&self, provider: Option<Arc<dyn MachineAccessProvider>>) {
        self.instance.registered.lock().machine_access = provider;
    }

    pub fn set_public_url(&self, url: Option<String>) {
        self.instance.registered.lock().public_url = url;
    }

    pub fn on_dispose(&self, dispose: Disposer) {
        self.instance.registered.lock().disposers.push(dispose);
    }

    /// Registers a hook that runs before the ones already registered.
    pub fn on_dispose_last(&self, dispose: Disposer) {
        self.instance.registered.lock().disposers.insert(0, dispose);
    }

    /// The token services and dispose hooks watch for unload.
    pub fn stopping(&self) -> CancellationToken {
        self.instance.stopping.clone()
    }
}

/// Applies `statements` in order, once each, to a plugin database; a
/// statement that changed after it was applied is an error
/// (`bb.storage.migrate`).
pub fn migrate(
    database: &rusqlite::Connection,
    statements: &[&str],
    now: i64,
) -> Result<(), String> {
    let fail = |error: rusqlite::Error| error.to_string();
    database.execute_batch(MIGRATIONS_TABLE).map_err(fail)?;
    let applied: Vec<Option<String>> = {
        let sql = "SELECT statement_hash FROM _bb_migrations ORDER BY id";
        let mut statement = database.prepare(sql).map_err(fail)?;
        let rows = statement.query_map([], |row| row.get(0)).map_err(fail)?;
        rows.collect::<Result<_, _>>().map_err(fail)?
    };
    database.execute_batch("BEGIN").map_err(fail)?;
    let run = || -> Result<(), String> {
        for (index, statement) in statements.iter().enumerate() {
            let hash = hex::encode(Sha256::digest(statement.as_bytes()));
            match applied.get(index) {
                None => {
                    database.execute_batch(statement).map_err(fail)?;
                    let record = "INSERT INTO _bb_migrations VALUES (?, ?, ?)";
                    database
                        .execute(record, rusqlite::params![index as i64, now, hash])
                        .map_err(fail)?;
                }
                Some(recorded) if recorded.as_deref().unwrap_or(&hash) != hash => {
                    return Err(format!(
                        "Migration {index} changed after it was applied; append a new one"
                    ));
                }
                Some(_) => {}
            }
        }
        Ok(())
    };
    match run() {
        Ok(()) => database.execute_batch("COMMIT").map_err(fail),
        Err(error) => {
            let _ = database.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

pub fn plugin_data_dir(data_dir: &Path, plugin_id: &str) -> PathBuf {
    data_dir.join("plugins").join(plugin_id)
}

pub fn create_plugin_instance(
    host: &PluginApiHost,
    plugin_id: &str,
) -> std::io::Result<(Arc<PluginInstance>, PluginApi)> {
    let data_dir = plugin_data_dir(&host.data_dir, plugin_id);
    std::fs::create_dir_all(&data_dir)?;
    let log = PluginLog { log: host.log.clone(), plugin_id: plugin_id.to_owned() };
    let secrets_dir = data_dir.join("secrets");
    let settings = Arc::new(PluginSettings::new(host.db.clone(), plugin_id, secrets_dir));
    let instance = Arc::new(PluginInstance {
        plugin_id: plugin_id.to_owned(),
        settings,
        log: log.clone(),
        stopping: CancellationToken::new(),
        registered: Mutex::default(),
    });
    let api = PluginApi {
        plugin_id: plugin_id.to_owned(),
        log,
        data_dir,
        server_url: host.server_url.clone(),
        server_data_dir: host.data_dir.clone(),
        outward: (host.deps)(plugin_id),
        instance: instance.clone(),
        db: host.db.clone(),
        hub: host.hub.clone(),
    };
    Ok((instance, api))
}
