use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bb_server::db::Db;
use bb_server::error::ApiResult;
use bb_server::log::Logger;
use bb_server::plugins::api::*;
use bb_server::plugins::instance::{PluginApiHost, create_plugin_instance};
use bb_server::plugins::js::start_js_plugin;
use bb_server::ws::hub::Hub;
use http_body_util::BodyExt;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Outward {
    calls: Mutex<Vec<String>>,
}

#[async_trait]
impl PluginOutward for Outward {
    async fn threads_spawn(&self, _: Value) -> ApiResult<Value> {
        Ok(Value::Null)
    }
    async fn threads_send(&self, _: &str, _: Value) -> ApiResult<Value> {
        Ok(Value::Null)
    }
    async fn threads_get(&self, id: &str) -> ApiResult<Option<Value>> {
        self.calls.lock().push(format!("threads.get {id}"));
        Ok(Some(json!({ "id": id })))
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
        Ok(json!([{ "id": "p1" }]))
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
    async fn files_read(&self, args: FileReadArgs) -> ApiResult<Option<FileRead>> {
        self.calls.lock().push(format!("files.read {}", args.path));
        Ok(Some(FileRead { content: "hello".into(), sha256: "abc".into() }))
    }
    async fn files_write(&self, _: FileWriteArgs) -> ApiResult<FileWriteOutcome> {
        Ok(FileWriteOutcome::Conflict)
    }
    async fn request_input(&self, request: InputRequest) -> InputResult {
        assert_eq!((request.title.as_str(), request.timeout_ms), ("Pick", Some(1000)));
        assert!(request.cancel.is_some());
        let describe = request.describe_submission.expect("describeSubmission");
        let value = describe(json!("A")).await.unwrap_or(Value::Null);
        InputResult::Submitted { value }
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Bundles the fixture plugin with `scripts/build-plugin-bundles.mjs` (needs
/// node and node_modules here or under `BB_NODE_MODULES_ROOT`).
fn bundle_fixture(out: &Path) -> String {
    let status = std::process::Command::new("node")
        .arg(repo_root().join("scripts/build-plugin-bundles.mjs"))
        .arg(out)
        .arg("fixture=crates/bb-server/tests/fixtures/plugin_js/plugin.ts")
        .status()
        .expect("node runs");
    assert!(status.success(), "bundling the fixture plugin failed");
    std::fs::read_to_string(out.join("fixture.mjs")).unwrap()
}

fn context(thread: &str, provider: &str) -> ThreadContext {
    ThreadContext {
        thread_id: thread.into(),
        project_id: "p1".into(),
        host_id: None,
        provider_id: provider.into(),
        provider_capabilities: None,
    }
}

async fn rpc(
    instance: &bb_server::plugins::instance::PluginInstance,
    method: &str,
    input: Value,
) -> Result<Value, RpcFailure> {
    instance.rpc(method).expect(method).call(input).await
}

#[tokio::test(flavor = "current_thread")]
async fn the_fixture_plugin_exercises_every_bridge_member() {
    let temp = tempfile::tempdir().unwrap();
    let source = bundle_fixture(&temp.path().join("bundles"));
    let outward = Arc::new(Outward::default());
    let deps_outward = outward.clone();
    let host = PluginApiHost {
        db: Db::open_in_memory(None).unwrap(),
        hub: Hub::new(),
        log: Logger::silent(),
        data_dir: temp.path().join("data"),
        server_url: "http://127.0.0.1:1".into(),
        deps: Arc::new(move |_| deps_outward.clone() as Arc<dyn PluginOutward>),
    };
    let (instance, api) = create_plugin_instance(&host, "fixture").unwrap();
    let kv = api.kv();
    start_js_plugin(&source, api).await.unwrap();

    assert_eq!(rpc(&instance, "add", json!({ "a": 2, "b": 3 })).await.unwrap(), json!(5));
    let invalid = rpc(&instance, "add", json!({ "a": "x" })).await.unwrap_err();
    assert_eq!(invalid.code, RpcErrorCode::InvalidInput);
    let issues = invalid.issues.unwrap();
    assert_eq!(issues.as_array().unwrap().len(), 2);
    assert_eq!(issues[0]["path"], json!(["a"]));
    assert_eq!(invalid.message, issues[0]["message"].as_str().unwrap());
    let failed = rpc(&instance, "fail", json!({})).await.unwrap_err();
    assert_eq!(
        (failed.code, failed.message.as_str(), failed.issues),
        (RpcErrorCode::HandlerError, "boom", None)
    );
    let wrong = rpc(&instance, "wrong", json!({})).await.unwrap_err();
    assert_eq!(wrong.code, RpcErrorCode::InvalidOutput);

    let storage = rpc(&instance, "storage", json!({})).await.unwrap();
    assert_eq!(storage["kv"], json!({ "n": 1 }));
    assert_eq!(storage["missing"], json!(true));
    assert_eq!(storage["keys"], json!(["a/1"]));
    assert_eq!(storage["rows"], json!([{ "v": "x" }]));
    assert_eq!(storage["journal"], json!("wal"));
    assert_eq!(
        storage["changed"],
        json!("Migration 0 changed after it was applied; append a new one")
    );
    assert_eq!(storage["settings"], json!({ "greeting": "hi" }));
    assert_eq!(storage["updated"], json!({ "greeting": "hello" }));

    let outward_result = rpc(&instance, "outward", json!({})).await.unwrap();
    assert_eq!(
        outward_result["answer"],
        json!({ "outcome": "submitted", "value": { "described": "A" } })
    );
    assert_eq!(outward_result["thread"], json!({ "id": "t1" }));
    assert_eq!(outward_result["file"], json!({ "content": "hello", "sha256": "abc" }));
    assert_eq!(outward_result["projects"], json!([{ "id": "p1" }]));
    assert_eq!(*outward.calls.lock(), vec!["threads.get t1", "files.read a.txt"]);

    let route = instance.route("POST /echo").expect("route");
    let request = http::Request::builder()
        .method("POST")
        .uri("/echo?x=1")
        .body(axum::body::Body::from("ping"))
        .unwrap();
    let response = route.handler.handle(request).await;
    assert_eq!(response.status(), 201);
    assert_eq!(response.headers()["x-plugin"], "fixture");
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&body[..], b"POST /echo ping");

    let cli = instance.cli().expect("cli");
    assert_eq!(
        (cli.name(), cli.summary(), cli.commands().len()),
        ("fixture".into(), "Fixture commands".into(), 1)
    );
    let cli_context = CliContext { thread_id: Some("t9".into()), ..CliContext::default() };
    let ran = cli.run(vec!["echo".into(), "hi".into()], cli_context).await;
    assert_eq!((ran.exit_code, ran.stdout.as_str()), (0, "echo hi t9"));

    let tool = instance.tools().into_iter().next().expect("tool");
    assert_eq!((tool.name(), tool.instructions()), ("shout".into(), Some("Use it loudly".into())));
    assert_eq!(tool.input_schema()["properties"]["text"]["type"], json!("string"));
    assert_eq!(tool.input_schema()["required"], json!(["text"]));
    assert!(tool.enabled_for(&context("t1", "codex")).await);
    assert!(!tool.enabled_for(&context("t1", "hidden")).await);
    let done = tool
        .execute(json!({ "text": "hey" }), context("t1", "codex"), CancellationToken::new())
        .await;
    assert_eq!(done, Ok(AgentToolResult::Text("HEY in t1".into())));
    let bad =
        tool.execute(json!({ "text": 1 }), context("t1", "codex"), CancellationToken::new()).await;
    match bad {
        Err(ToolFailure::InvalidArguments(message)) => {
            assert!(message.contains("expected string"), "{message}")
        }
        other => panic!("unexpected {other:?}"),
    }

    let instructions = instance.instructions();
    assert_eq!(
        instructions[0](context("t5", "codex")).await.unwrap(),
        Some("Instructions for t5".into())
    );
    let (provider, env) = instance.env().into_iter().next().unwrap();
    assert_eq!(provider, "codex");
    assert_eq!(env(context("t5", "codex")).await.unwrap()[0].value, EnvValue::Literal("1".into()));
    let mention = instance.mention_providers().into_iter().next().unwrap();
    assert_eq!((mention.id(), mention.triggers()), ("docs".into(), vec!["@".to_owned()]));
    let query =
        MentionQuery { trigger: "@".into(), query: "q".into(), project_id: None, thread_id: None };
    assert_eq!(mention.search(query).await.unwrap()[0].id, "doc-q");
    assert_eq!(mention.resolve("doc-q").await.unwrap(), "content of doc-q");
    let inference = instance.inference().into_iter().next().unwrap();
    assert_eq!(inference.complete("p", CancellationToken::new()).await.unwrap(), "<p>");
    assert_eq!(instance.environments()[0].display_name, "Fixture");
    assert_eq!(instance.needs_configuration(), Some("configure me".into()));
    assert_eq!(instance.public_url(), Some("http://127.0.0.1:1/public".into()));

    for listener in instance.listeners("thread.created") {
        listener(json!({ "thread": { "id": "t7" } })).await.unwrap();
    }
    instance.start_services();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let journal = rpc(&instance, "journal", json!({})).await.unwrap();
    assert_eq!(journal, json!(["settings hi->hello", "created t7", "service started"]));

    instance.dispose().await;
    assert_eq!(kv.get("disposed").unwrap(), Some(json!(["second", "first"])));
    assert_eq!(kv.get("service").unwrap(), Some(json!("aborted")));
    assert!(instance.rpc("add").unwrap().call(json!({ "a": 1, "b": 1 })).await.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn a_plugin_that_throws_while_starting_fails_with_its_message() {
    let temp = tempfile::tempdir().unwrap();
    let host = PluginApiHost {
        db: Db::open_in_memory(None).unwrap(),
        hub: Hub::new(),
        log: Logger::silent(),
        data_dir: temp.path().to_path_buf(),
        server_url: "http://127.0.0.1:1".into(),
        deps: Arc::new(|_| Arc::new(Outward::default()) as Arc<dyn PluginOutward>),
    };
    let (_, api) = create_plugin_instance(&host, "broken").unwrap();
    let source = "export default async () => { throw new Error(\"not configured\"); };";
    let error = start_js_plugin(source, api).await.unwrap_err();
    assert_eq!(error.message, "not configured");
}
