use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use bb_core::{ToolCallOutputItem, ToolCallResponse};
use bb_server::config::ServerConfig;
use bb_server::db::Db;
use bb_server::error::ApiResult;
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::api::*;
use bb_server::plugins::builtin::{BuiltinPlugin, BuiltinServer};
use bb_server::plugins::host::{PluginHost, PluginHostOptions, TitleFallback};
use bb_server::plugins::instance::PluginApi;
use bb_server::plugins::manifest::{derive_plugin_id, read_manifest, resolve_inside};
use bb_server::ws::hub::Hub;
use futures::FutureExt;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

type Journal = Arc<Mutex<Vec<String>>>;

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
        Ok(json!([]))
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
        Ok(json!([]))
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
        InputResult::Cancelled { reason: "user".into() }
    }
}

struct Tool {
    name: &'static str,
    result: Result<AgentToolResult, ToolFailure>,
    instructions: Option<&'static str>,
    hidden_for: Option<&'static str>,
}

#[async_trait]
impl AgentTool for Tool {
    fn name(&self) -> String {
        self.name.into()
    }
    fn description(&self) -> String {
        format!("The {} tool", self.name)
    }
    fn instructions(&self) -> Option<String> {
        self.instructions.map(str::to_owned)
    }
    fn input_schema(&self) -> Value {
        json!({ "type": "object" })
    }
    async fn enabled_for(&self, context: &ThreadContext) -> bool {
        self.hidden_for != Some(context.provider_id.as_str())
    }
    async fn execute(
        &self,
        input: Value,
        _: ThreadContext,
        _: CancellationToken,
    ) -> Result<AgentToolResult, ToolFailure> {
        match &self.result {
            Ok(AgentToolResult::Text(text)) if text == "echo" => {
                Ok(AgentToolResult::Text(input.to_string()))
            }
            other => other.clone(),
        }
    }
}

struct Ping;

#[async_trait]
impl RpcHandler for Ping {
    async fn call(&self, input: Value) -> Result<Value, RpcFailure> {
        Ok(json!({ "pong": input }))
    }
}

struct Mentions;

#[async_trait]
impl MentionProvider for Mentions {
    fn id(&self) -> String {
        "notes".into()
    }
    fn label(&self) -> String {
        "Notes".into()
    }
    async fn search(&self, query: MentionQuery) -> PluginResult<Vec<MentionItem>> {
        Ok(vec![MentionItem {
            id: format!("n:{}", query.query),
            title: "A note".into(),
            subtitle: None,
            icon: None,
        }])
    }
    async fn resolve(&self, item_id: &str) -> PluginResult<String> {
        Ok(format!("context of {item_id}"))
    }
}

struct Inference(&'static str);

#[async_trait]
impl InferenceService for Inference {
    fn id(&self) -> String {
        "llm".into()
    }
    fn display_name(&self) -> String {
        "LLM".into()
    }
    async fn complete(&self, _: &str, _: CancellationToken) -> PluginResult<String> {
        Ok(self.0.into())
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Alpha,
    Failing,
    Configurable,
    Titles(&'static str),
}

struct TestPlugin {
    kind: Kind,
    journal: Journal,
}

#[async_trait]
impl NativePlugin for TestPlugin {
    async fn start(&self, api: PluginApi) -> PluginResult<()> {
        let journal = self.journal.clone();
        let push = move |entry: &str| journal.lock().push(entry.to_owned());
        push(&format!("start:{}", api.plugin_id));
        match self.kind {
            Kind::Alpha => {
                api.rpc_register("ping", Arc::new(Ping));
                let tool = |name, result, instructions, hidden_for| {
                    Arc::new(Tool { name, result, instructions, hidden_for })
                };
                api.register_tool(tool(
                    "echo",
                    Ok(AgentToolResult::Text("echo".into())),
                    Some("Use echo."),
                    None,
                ));
                api.register_tool(tool(
                    "boom",
                    Err(ToolFailure::Failed("kaboom".into())),
                    None,
                    None,
                ));
                api.register_tool(tool(
                    "strict",
                    Err(ToolFailure::InvalidArguments("bad".into())),
                    None,
                    None,
                ));
                let detailed = AgentToolResult::Detailed { text: "partial".into(), is_error: true };
                api.register_tool(tool("detailed", Ok(detailed), None, None));
                api.register_tool(tool(
                    "hidden",
                    Ok(AgentToolResult::Text("x".into())),
                    Some("Hidden."),
                    Some("claude"),
                ));
                api.contribute_instructions(Arc::new(|context: ThreadContext| {
                    async move { Ok(Some(format!("Alpha rules for {}", context.thread_id))) }
                        .boxed()
                }));
                api.contribute_instructions(Arc::new(|_| async { Ok(Some("  ".into())) }.boxed()));
                api.contribute_instructions(Arc::new(|_| {
                    async { Err(PluginError::new("no instructions")) }.boxed()
                }));
                api.contribute_env(
                    "codex",
                    Arc::new(|_| {
                        async {
                            Ok(vec![ProviderEnvEntry {
                                name: "ALPHA".into(),
                                value: EnvValue::Literal("1".into()),
                            }])
                        }
                        .boxed()
                    }),
                );
                api.register_mention_provider(Arc::new(Mentions));
                let service_journal = self.journal.clone();
                api.background_service(
                    "ticker",
                    Arc::new(move |stop: CancellationToken| {
                        let journal = service_journal.clone();
                        async move {
                            stop.cancelled().await;
                            journal.lock().push("alpha:service-stopped".into());
                            Ok(())
                        }
                        .boxed()
                    }),
                );
                for name in ["alpha:dispose1", "alpha:dispose2"] {
                    let journal = self.journal.clone();
                    api.on_dispose(Box::new(move || {
                        async move { journal.lock().push(name.into()) }.boxed()
                    }));
                }
            }
            Kind::Failing => return Err(PluginError::new("boom on start")),
            Kind::Configurable => {
                let secret = SettingDescriptor::String {
                    label: "API key".into(),
                    description: None,
                    secret: Some(true),
                    multiline: None,
                    default: None,
                };
                let settings = api.settings_define(IndexMap::from([("apiKey".into(), secret)]));
                let values = settings.get().await.map_err(PluginError::from)?;
                if values.get("apiKey").is_none_or(Value::is_null) {
                    api.needs_configuration("Set an API key");
                }
            }
            Kind::Titles(text) => api.register_inference(Arc::new(Inference(text))),
        }
        Ok(())
    }
}

fn write_package(directory: &Path, package: Value) {
    std::fs::create_dir_all(directory).unwrap();
    std::fs::write(directory.join("package.json"), package.to_string()).unwrap();
}

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    host: PluginHost,
    journal: Journal,
}

fn fixture_with(kinds: &[(&str, Option<Kind>)], external: Option<Value>) -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().to_path_buf();
    let data_dir = root.join("data");
    std::fs::create_dir_all(&data_dir).unwrap();
    if let Some(config) = external {
        std::fs::write(data_dir.join("config.json"), config.to_string()).unwrap();
    }
    let journal: Journal = Arc::default();
    let builtins = kinds
        .iter()
        .map(|(name, kind)| {
            let directory = root.join("builtin").join(name);
            write_package(
                &directory,
                json!({ "name": format!("@bb/plugin-{name}"), "bb": {
                    "name": name.to_uppercase(), "icon": "./icon.svg", "skills": ["skills"] } }),
            );
            let server = match kind {
                Some(kind) => BuiltinServer::Native(Arc::new(TestPlugin {
                    kind: *kind,
                    journal: journal.clone(),
                })),
                None => BuiltinServer::None,
            };
            BuiltinPlugin { directory, server }
        })
        .collect();
    let config = ServerConfig {
        data_dir,
        port: 0,
        bind_host: "127.0.0.1".into(),
        allowed_hosts: Vec::new(),
        app_dir: root.join("app"),
        cli_dir: root.join("cli"),
        bb_cli_path: root.join("bb"),
        version: "0.0.0".into(),
        host_id: "host".into(),
        log_level: LogLevel::Silent,
    };
    let host = PluginHost::new(PluginHostOptions {
        config,
        db: Db::open_in_memory(None).unwrap(),
        hub: Hub::new(),
        log: Logger::silent(),
        builtins: Some(builtins),
    });
    host.set_deps(Arc::new(|_: &str| Arc::new(Outward) as Arc<dyn PluginOutward>));
    Fixture { _temp: temp, root, host, journal }
}

async fn standard() -> Fixture {
    let fixture = fixture_with(
        &[
            ("alpha", Some(Kind::Alpha)),
            ("beta", Some(Kind::Failing)),
            ("gamma", Some(Kind::Configurable)),
        ],
        None,
    );
    fixture.host.reload(None).await.unwrap();
    fixture
}

fn status(host: &PluginHost, id: &str) -> (String, Value) {
    let plugin = host.list().into_iter().find(|plugin| plugin["id"] == id).unwrap();
    (plugin["status"].as_str().unwrap().to_owned(), plugin["statusMessage"].clone())
}

fn context(provider_id: &str) -> ThreadContext {
    ThreadContext {
        thread_id: "thr_1".into(),
        project_id: "prj_1".into(),
        host_id: None,
        provider_id: provider_id.into(),
        provider_capabilities: None,
    }
}

fn text(response: &ToolCallResponse) -> (String, bool) {
    let ToolCallOutputItem::InputText { text } = &response.content_items[0] else {
        panic!("not text")
    };
    (text.clone(), response.success)
}

#[tokio::test]
async fn discovers_builtins_and_describes_them() {
    let fixture = standard().await;
    let list = fixture.host.list();
    let ids: Vec<&str> = list.iter().map(|plugin| plugin["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["plugin-alpha", "plugin-beta", "plugin-gamma"]);
    assert_eq!(
        list[0],
        json!({
            "id": "plugin-alpha", "name": "ALPHA", "description": "",
            "icon": "/api/v1/plugins/plugin-alpha/assets/icon.svg", "enabled": true,
            "status": "running", "statusMessage": null, "hasSettings": false, "settings": {},
            "app": null, "cliCommands": [],
        })
    );
    assert_eq!(status(&fixture.host, "plugin-beta"), ("error".into(), json!("boom on start")));
    assert_eq!(
        status(&fixture.host, "plugin-gamma"),
        ("needs-configuration".into(), json!("Set an API key"))
    );
    assert_eq!(list[2]["hasSettings"], true);
    let skills = fixture.host.skill_dirs();
    assert_eq!(skills.len(), 2);
    assert!(skills[0].ends_with("builtin/alpha/skills"));
    assert_eq!(
        fixture.host.contributions(),
        json!({ "cliCommands": [], "mentionProviders": [
            { "pluginId": "plugin-alpha", "id": "notes", "label": "Notes", "triggers": ["@"] }] })
    );
    let error = fixture.host.running("plugin-beta").err().unwrap();
    assert_eq!(error.code(), "plugin_unavailable");
    assert!(error.to_string().contains("Plugin \"plugin-beta\" is not running: boom on start"));
    assert_eq!(fixture.host.running("nope").err().unwrap().code(), "not_found");
    let ping = fixture.host.running("plugin-alpha").unwrap().rpc("ping").unwrap();
    assert_eq!(ping.call(json!(1)).await.unwrap(), json!({ "pong": 1 }));
}

#[tokio::test]
async fn disables_and_enables_with_dispose_order() {
    let fixture = standard().await;
    fixture.journal.lock().clear();
    tokio::task::yield_now().await;
    let described = fixture.host.set_enabled("plugin-alpha", false).await.unwrap();
    assert_eq!(described["status"], "disabled");
    assert_eq!(described["enabled"], false);
    assert_eq!(described["statusMessage"], Value::Null);
    let journal = fixture.journal.lock().clone();
    let disposals: Vec<&String> = journal.iter().filter(|e| e.contains("dispose")).collect();
    assert_eq!(disposals, ["alpha:dispose2", "alpha:dispose1"]);
    assert!(fixture.host.tools_for(&context("codex")).await.is_empty());
    let described = fixture.host.set_enabled("plugin-alpha", true).await.unwrap();
    assert_eq!(described["status"], "running");
    assert!(fixture.journal.lock().contains(&"start:plugin-alpha".to_owned()));
    fixture.host.reload(Some("plugin-alpha")).await.unwrap();
    assert_eq!(status(&fixture.host, "plugin-alpha").0, "running");
    assert!(fixture.host.reload(Some("nope")).await.is_err());
    fixture.host.stop().await;
    assert!(fixture.host.running("plugin-alpha").is_err());
}

#[tokio::test]
async fn settings_write_reloads_a_plugin_waiting_for_configuration() {
    let fixture = standard().await;
    let view = fixture.host.settings("plugin-gamma", None).await.unwrap();
    assert!(view.schema.contains_key("apiKey"));
    assert_eq!(view.values["apiKey"], json!({ "set": false }));
    let update = IndexMap::from([("apiKey".to_owned(), json!("sk-1"))]);
    let view = fixture.host.settings("plugin-gamma", Some(update)).await.unwrap();
    assert_eq!(view.values["apiKey"], json!({ "set": true }));
    assert_eq!(status(&fixture.host, "plugin-gamma"), ("running".into(), Value::Null));
    let starts = fixture.journal.lock().iter().filter(|e| *e == "start:plugin-gamma").count();
    assert_eq!(starts, 2);
    assert!(fixture.host.settings("plugin-beta", None).await.is_err());
}

#[tokio::test]
async fn mints_rotates_and_checks_tokens() {
    let fixture = standard().await;
    let host = &fixture.host;
    assert!(!host.accepts_token("plugin-alpha", None));
    assert!(!host.accepts_token("plugin-alpha", Some("")));
    let token = host.token("plugin-alpha", false).unwrap();
    assert_eq!(token.len(), 32);
    assert_eq!(host.token("plugin-alpha", false).unwrap(), token);
    assert!(host.accepts_token("plugin-alpha", Some(&token)));
    assert!(!host.accepts_token("plugin-alpha", Some("wrong")));
    assert!(!host.accepts_token("plugin-beta", Some(&token)));
    host.set_enabled("plugin-alpha", false).await.unwrap();
    assert!(host.accepts_token("plugin-alpha", Some(&token)));
    let rotated = host.token("plugin-alpha", true).unwrap();
    assert_ne!(rotated, token);
    assert!(!host.accepts_token("plugin-alpha", Some(&token)));
    assert!(host.token("nope", false).is_err());
    assert!(!host.accepts_token("nope", Some(&token)));
}

#[tokio::test]
async fn answers_tool_queries() {
    let fixture = standard().await;
    let host = &fixture.host;
    let names = |tools: Vec<bb_core::DynamicTool>| -> Vec<String> {
        tools.into_iter().map(|tool| tool.name).collect()
    };
    assert_eq!(
        names(host.tools_for(&context("codex")).await),
        ["echo", "boom", "strict", "detailed", "hidden"]
    );
    assert!(!names(host.tools_for(&context("claude")).await).contains(&"hidden".to_owned()));
    let call = |name: &'static str, provider: &'static str| {
        host.call_tool(name, json!({ "a": 1 }), context(provider), CancellationToken::new())
    };
    assert_eq!(text(&call("echo", "codex").await), (r#"{"a":1}"#.into(), true));
    assert_eq!(text(&call("missing", "codex").await), ("Unknown tool \"missing\"".into(), false));
    assert_eq!(text(&call("hidden", "claude").await), ("Unknown tool \"hidden\"".into(), false));
    assert_eq!(text(&call("boom", "codex").await), ("Tool failed: kaboom".into(), false));
    assert_eq!(text(&call("strict", "codex").await), ("Invalid arguments: bad".into(), false));
    assert_eq!(text(&call("detailed", "codex").await), ("partial".into(), false));
}

#[tokio::test]
async fn joins_instructions_env_and_mentions() {
    let fixture = standard().await;
    let host = &fixture.host;
    assert_eq!(
        host.instructions_for(&context("codex")).await,
        "Use echo.\n\nHidden.\n\nAlpha rules for thr_1"
    );
    assert_eq!(
        host.instructions_for(&context("claude")).await,
        "Use echo.\n\nAlpha rules for thr_1"
    );
    let env = host.contributed_env("codex", &context("codex")).await;
    assert_eq!(
        env,
        [ProviderEnvEntry { name: "ALPHA".into(), value: EnvValue::Literal("1".into()) }]
    );
    assert!(host.contributed_env("claude", &context("claude")).await.is_empty());
    let query = |text: &str, trigger: &str| MentionQuery {
        trigger: trigger.into(),
        query: text.into(),
        project_id: None,
        thread_id: None,
    };
    assert!(host.search_mentions(query("", "@")).await.is_empty());
    assert!(host.search_mentions(query("x", "#")).await.is_empty());
    assert_eq!(
        host.search_mentions(query("x", "@")).await,
        [json!({ "pluginId": "plugin-alpha", "providerId": "notes", "label": "Notes",
            "items": [{ "itemId": "notes:n:x", "title": "A note", "subtitle": null, "icon": null }] })]
    );
    assert_eq!(host.resolve_mention("plugin-alpha", "notes:n:x").await.unwrap(), "context of n:x");
    assert!(host.resolve_mention("plugin-alpha", "other:1").await.is_err());
    assert_eq!(host.public_url(), None);
    assert!(host.machine_access().is_none());
}

#[tokio::test]
async fn generates_titles_with_the_fallback_rule() {
    let fallback: TitleFallback =
        Arc::new(|task: String, _| async move { Some(format!("fb:{task}")) }.boxed());
    let fixture = fixture_with(&[("plain", None)], None);
    fixture.host.reload(None).await.unwrap();
    assert_eq!(fixture.host.generate_title("hi", CancellationToken::new()).await, None);
    fixture.host.set_title_fallback(Some(fallback.clone()));
    let title = fixture.host.generate_title("hi", CancellationToken::new()).await;
    assert_eq!(title.as_deref(), Some("fb:hi"));

    let fixture = fixture_with(&[("blank", Some(Kind::Titles("  ")))], None);
    fixture.host.reload(None).await.unwrap();
    fixture.host.set_title_fallback(Some(fallback.clone()));
    assert_eq!(fixture.host.generate_title("hi", CancellationToken::new()).await, None);

    let fixture = fixture_with(&[("good", Some(Kind::Titles(" A title ")))], None);
    fixture.host.reload(None).await.unwrap();
    fixture.host.set_title_fallback(Some(fallback));
    let title = fixture.host.generate_title("hi", CancellationToken::new()).await;
    assert_eq!(title.as_deref(), Some("A title"));
}

#[tokio::test]
async fn external_plugins_replace_builtins_and_honour_config() {
    let temp = tempfile::tempdir().unwrap();
    let replacement = temp.path().join("alpha-ext");
    write_package(&replacement, json!({ "name": "@bb/plugin-alpha", "bb": { "name": "Ext" } }));
    let off = temp.path().join("off");
    write_package(&off, json!({ "name": "bb-plugin-off", "bb": { "name": "Off" } }));
    let broken = temp.path().join("broken");
    write_package(&broken, json!({ "name": "broken" }));
    let config = json!({ "plugins": [
        { "path": replacement }, { "path": off, "enabled": false }, { "path": broken } ] });
    let fixture = fixture_with(&[("alpha", Some(Kind::Alpha))], Some(config));
    fixture.host.reload(None).await.unwrap();
    let list = fixture.host.list();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0]["name"], "Ext");
    assert_eq!(list[0]["status"], "running");
    assert!(!fixture.journal.lock().contains(&"start:plugin-alpha".to_owned()));
    assert_eq!(list[1]["id"], "off");
    assert_eq!(list[1]["status"], "disabled");
    assert_eq!(list[1]["statusMessage"], "Disabled in config.json");
    drop(fixture.root);
}

#[tokio::test]
async fn reads_manifests_confined_to_their_directory() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("plugin");
    write_package(
        &directory,
        json!({ "name": "@acme/bb-plugin-My_Tool", "bb": {
            "name": "My Tool", "server": "./src/server.ts", "app": "src/app.tsx",
            "skills": ["skills/a"] } }),
    );
    let manifest = read_manifest(&directory).await.unwrap();
    assert_eq!(manifest.id, "my-tool");
    assert_eq!(manifest.description, "");
    assert_eq!(manifest.icon, None);
    assert_eq!(manifest.server_entry, Some(directory.join("src/server.ts")));
    assert_eq!(manifest.app_entry, Some(directory.join("src/app.tsx")));
    assert_eq!(manifest.skill_dirs, [directory.join("skills/a")]);
    write_package(&directory, json!({ "name": "x", "bb": { "name": "X", "server": "../out.ts" } }));
    let error = read_manifest(&directory).await.unwrap_err();
    assert_eq!(error.message, "\"../out.ts\" is outside the plugin directory");
    write_package(&directory, json!({ "name": "x", "bb": { "name": "X", "app": "/etc/passwd" } }));
    assert!(read_manifest(&directory).await.is_err());
    write_package(&directory, json!({ "name": "x", "bb": { "name": "" } }));
    assert!(read_manifest(&directory).await.is_err());
    assert_eq!(resolve_inside(&directory, "."), None);
    assert_eq!(resolve_inside(&directory, "a/../b"), Some(directory.join("b")));
    assert_eq!(resolve_inside(&directory, "a/../../b"), None);
    assert_eq!(derive_plugin_id("bb-plugin-tasks").unwrap(), "tasks");
    assert_eq!(derive_plugin_id("@bb/Account Pool").unwrap(), "account-pool");
    assert!(derive_plugin_id("@scope/---").is_err());
}

#[tokio::test]
async fn an_external_plugin_without_esbuild_fails_alone() {
    let temp = tempfile::tempdir().unwrap();
    let missing = temp.path().join("no-esbuild");
    unsafe { std::env::set_var("BB_ESBUILD_PATH", &missing) };
    let echo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/server/test/fixtures/echo-plugin");
    let config = json!({ "plugins": [{ "path": echo }] });
    let fixture = fixture_with(&[("alpha", Some(Kind::Alpha))], Some(config));
    fixture.host.reload(None).await.unwrap();
    assert_eq!(status(&fixture.host, "plugin-alpha").0, "running");
    let (state, message) = status(&fixture.host, "echo");
    assert_eq!(state, "error");
    let message = message.as_str().unwrap().to_owned();
    assert!(message.starts_with("esbuild was not found at "), "{message}");
    let echo = fixture.host.list().into_iter().find(|plugin| plugin["id"] == "echo").unwrap();
    assert_eq!(echo["app"], Value::Null);
    assert_eq!(echo["icon"], "/api/v1/plugins/echo/assets/icon.svg");
}

#[test]
fn shared_module_shims_read_the_runtime_global() {
    use bb_server::plugins::bundle::{content_hash, shared_module_source};
    assert_eq!(
        shared_module_source("react/jsx-runtime").lines().next().unwrap(),
        r#"const shared = globalThis.__bbPluginRuntime["react/jsx-runtime"];"#
    );
    assert_eq!(content_hash("abc"), "ba7816bf8f01cfea");
}
