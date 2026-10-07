use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use bb_server::config::ServerConfig;
use bb_server::db::Db;
use bb_server::error::ApiResult;
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::api::*;
use bb_server::plugins::builtin::{BuiltinServer, builtin_plugins};
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::ws::hub::Hub;
use indexmap::IndexMap;
use serde_json::{Value, json};

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
        InputResult::Cancelled { reason: "test".into() }
    }
}

fn host(temp: &tempfile::TempDir, names: &[&str]) -> PluginHost {
    let root = temp.path();
    let builtins = builtin_plugins()
        .into_iter()
        .filter(|p| names.iter().any(|n| p.directory.ends_with(n)))
        .collect();
    let config = ServerConfig {
        data_dir: root.join("data"),
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
    host
}

fn context(native_question: Option<bool>) -> ThreadContext {
    ThreadContext {
        thread_id: "t1".into(),
        project_id: "p1".into(),
        host_id: None,
        provider_id: "codex".into(),
        provider_capabilities: native_question.map(|n| json!({ "supportsNativeUserQuestion": n })),
    }
}

fn built() -> bool {
    builtin_plugins().iter().all(|p| match p.server {
        BuiltinServer::Js(source) => !source.contains("plugin bundle was not built"),
        _ => true,
    })
}

#[tokio::test(flavor = "current_thread")]
async fn custom_instructions_and_ask_user_question_run_from_their_bundles() {
    assert!(built(), "plugin bundles were not built; run pnpm install");
    let temp = tempfile::tempdir().unwrap();
    let host = host(&temp, &["custom-instructions", "ask-user-question"]);
    host.reload(None).await.unwrap();
    assert_eq!(host.instructions_for(&context(None)).await, "");
    let mut update = IndexMap::new();
    update.insert("instructions".to_owned(), json!("Always be brief."));
    host.settings("custom-instructions", Some(update)).await.unwrap();
    assert!(host.instructions_for(&context(None)).await.contains("Always be brief."));

    let names =
        |tools: Vec<bb_core::DynamicTool>| tools.into_iter().map(|t| t.name).collect::<Vec<_>>();
    assert_eq!(names(host.tools_for(&context(Some(false))).await), vec!["AskUserQuestion"]);
    assert!(names(host.tools_for(&context(Some(true))).await).is_empty());
    assert!(names(host.tools_for(&context(None)).await).is_empty());
    let tool = host.running("ask-user-question").unwrap().tools().remove(0);
    assert_eq!(tool.input_schema()["type"], json!("object"));
    host.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn tasks_secrets_and_thread_list_start_from_their_bundles() {
    assert!(built(), "plugin bundles were not built; run pnpm install");
    for name in ["tasks", "secrets", "thread-list"] {
        let temp = tempfile::tempdir().unwrap();
        let host = host(&temp, &[name]);
        let started = Instant::now();
        host.reload(None).await.unwrap();
        let listed = host.list();
        eprintln!("{name}: {:?} {}", started.elapsed(), json!(listed));
        let instance = host.running(name).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(instance.needs_configuration(), None, "{name}");
        host.stop().await;
    }
}
