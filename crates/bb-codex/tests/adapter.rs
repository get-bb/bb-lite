mod replay;

use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bb_codex::adapter::{
    CodexAdapterOptions, MISSING_CLI, create_codex_adapter, is_standalone_builtin_compact_command,
};
use bb_codex::rpc::SpawnAppServer;
use bb_core::{
    ExecutionOptions, ProviderAuth, ProviderId, RunnerErrorCode, RunnerResult, SessionSpec,
    ToolCallResponse,
};
use bb_provider::{
    ExitInfo, Interaction, ProviderAdapter, ProviderSession, SessionHost, SessionHostCallbacks,
    ToolCall,
};
use indexmap::IndexMap;
use parking_lot::Mutex;
use replay::{FakeAppServer, builder, collector, fake_app_server};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;

fn options() -> ExecutionOptions {
    serde_json::from_value(json!({
        "model": "gpt-5",
        "reasoningLevel": "medium",
        "serviceTier": "default",
        "permissionMode": "full",
        "permissionEscalation": "ask",
    }))
    .expect("options")
}

fn spec() -> SessionSpec {
    SessionSpec {
        thread_id: "thr_test".into(),
        provider_id: ProviderId::Codex,
        cwd: "/tmp".into(),
        provider_thread_id: None,
        instructions: String::new(),
        dynamic_tools: Vec::new(),
        env: IndexMap::new(),
        skill_dirs: Vec::new(),
    }
}

#[derive(Default)]
struct Host {
    calls: Mutex<Vec<ToolCall>>,
}

#[async_trait]
impl SessionHostCallbacks for Host {
    async fn call_tool(&self, call: ToolCall) -> RunnerResult<ToolCallResponse> {
        self.calls.lock().push(call);
        Ok(ToolCallResponse::text("done", true))
    }

    async fn request_interaction(&self, _interaction: Interaction) -> RunnerResult<Value> {
        Ok(json!({ "decision": "allow" }))
    }

    fn on_exit(&self, _info: ExitInfo) {}
}

fn host(callbacks: Arc<Host>) -> SessionHost {
    SessionHost {
        events: builder(collector().0),
        env: IndexMap::new(),
        process_env: IndexMap::new(),
        thread_storage_dir: "/unused".into(),
        writable_roots: Vec::new(),
        callbacks,
    }
}

struct Script {
    server: Arc<Mutex<Option<FakeAppServer>>>,
    launches: Arc<Mutex<Vec<Vec<String>>>>,
}

impl Script {
    fn adapter() -> (Arc<dyn ProviderAdapter>, Self) {
        let server: Arc<Mutex<Option<FakeAppServer>>> = Arc::default();
        let launches: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
        let (slot, seen) = (server.clone(), launches.clone());
        let spawn: SpawnAppServer = Arc::new(move |command, args, _launch| {
            seen.lock().push([&[command.to_owned()], args].concat());
            let (fake, child) = fake_app_server();
            *slot.lock() = Some(fake);
            child
        });
        let options = CodexAdapterOptions { spawn: Some(spawn), command: Some("codex-x".into()) };
        (create_codex_adapter(options), Self { server, launches })
    }

    async fn written(&self, matches: impl Fn(&Value) -> bool) -> Value {
        for _ in 0..500 {
            let found = self.server.lock().as_ref().and_then(|server| {
                let mut written = server.written.lock();
                let index = written.iter().position(&matches)?;
                Some(written.remove(index))
            });
            if let Some(message) = found {
                return message;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        panic!("nothing matching was written");
    }

    async fn send(&self, message: Value) {
        let stdout = self.server.lock().as_ref().map(|server| server.stdout.clone());
        let stdout = stdout.expect("spawned");
        let mut stdout = stdout.lock().await;
        let line = format!("{message}\n");
        stdout.as_mut().expect("open").write_all(line.as_bytes()).await.expect("write");
    }

    async fn answer(&self, method: &str, result: Value) -> Value {
        let request = self.written(|m| m["method"] == method).await;
        self.send(json!({ "id": request["id"], "result": result })).await;
        request
    }

    async fn open(adapter: &Arc<dyn ProviderAdapter>, script: &Self) -> Arc<dyn ProviderSession> {
        let callbacks = Arc::new(Host::default());
        let opening = {
            let adapter = adapter.clone();
            tokio::spawn(async move { adapter.open(spec(), options(), host(callbacks)).await })
        };
        script.answer("initialize", json!({})).await;
        let start = script.answer("thread/start", json!({ "thread": { "id": "th_1" } })).await;
        assert_eq!(start["params"]["ephemeral"], false);
        opening.await.expect("task").expect("open")
    }
}

#[tokio::test]
async fn opens_a_thread_and_renames_it() {
    let (adapter, script) = Script::adapter();
    let session = Script::open(&adapter, &script).await;
    assert_eq!(*script.launches.lock(), vec![vec!["codex-x".to_owned(), "app-server".into()]]);
    assert_eq!(session.provider_thread_id(), "th_1");
    assert!(session.can_apply(&spec(), &options()));
    let moved = SessionSpec { cwd: "/elsewhere".into(), ..spec() };
    assert!(!session.can_apply(&moved, &options()));
    let renaming = tokio::spawn({
        let session = session.clone();
        async move { session.rename("Fix it").await }
    });
    let request = script.answer("thread/name/set", json!({})).await;
    assert_eq!(request["params"], json!({ "threadId": "th_1", "name": "[bb] Fix it" }));
    renaming.await.expect("task").expect("rename");
    session.interrupt().await.expect("no active turn is a no-op");
    session.close().await.expect("close");
    assert!(!session.can_apply(&spec(), &options()));
}

#[tokio::test]
async fn serves_tool_calls_and_rejects_unknown_requests() {
    let (adapter, script) = Script::adapter();
    let session = Script::open(&adapter, &script).await;
    let call =
        json!({ "turnId": null, "callId": "call_1", "tool": "bb_tool", "arguments": { "a": 1 } });
    script.send(json!({ "id": 7, "method": "item/tool/call", "params": call })).await;
    let response = script.written(|m| m["id"] == 7).await;
    let content = json!([{ "type": "inputText", "text": "done" }]);
    assert_eq!(response["result"], json!({ "contentItems": content, "success": true }));
    script.send(json!({ "id": 8, "method": "item/unknown", "params": {} })).await;
    let rejected = script.written(|m| m["id"] == 8).await;
    assert_eq!(rejected["error"]["code"], -32601);
    assert_eq!(rejected["error"]["message"], "Unhandled codex request \"item/unknown\"");
    session.close().await.expect("close");
}

#[tokio::test]
async fn a_missing_executable_fails_to_open_and_list_models() {
    let options = CodexAdapterOptions { spawn: None, command: Some("/nonexistent/codex-x".into()) };
    let adapter = create_codex_adapter(options.clone());
    let callbacks = Arc::new(Host::default());
    let error = adapter.open(spec(), self::options(), host(callbacks)).await.err().expect("fails");
    assert_eq!(
        (error.code, error.message.as_str()),
        (RunnerErrorCode::MissingExecutable, MISSING_CLI)
    );
    let listing = adapter.list_models(Some("/")).await.expect_err("fails");
    assert_eq!(listing.code, RunnerErrorCode::MissingExecutable);
    let status = adapter.status().await.expect("status");
    assert!(!status.installed);
    assert_eq!(status.auth, ProviderAuth::Unknown);
    assert_eq!(status.message.as_deref(), Some(MISSING_CLI));
}

#[tokio::test]
async fn status_reports_version_and_sign_in() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("codex");
    let script =
        "#!/bin/sh\n[ \"$1\" = --version ] && { echo 'codex-cli 1.2.3'; exit 0; }\nexit 1\n";
    std::fs::write(&path, script).expect("write");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    let command = Some(path.to_string_lossy().into_owned());
    let status = create_codex_adapter(CodexAdapterOptions { spawn: None, command })
        .status()
        .await
        .expect("status");
    assert!(status.installed);
    assert_eq!(status.version.as_deref(), Some("1.2.3"));
    assert_eq!(status.auth, ProviderAuth::Unauthenticated);
    assert_eq!(status.message.as_deref(), Some("Run `codex login` to sign in."));
}

#[test]
fn recognizes_the_standalone_compact_command() {
    let mention = |source: &str| {
        json!({ "start": 0, "end": 8, "resource": {
            "kind": "command", "trigger": "/", "name": "compact", "source": source, "origin": "builtin",
        }})
    };
    let text = |text: &str, source: &str| {
        vec![json!({ "type": "text", "text": text, "mentions": [mention(source)] })]
    };
    assert!(is_standalone_builtin_compact_command(&text("/compact ", "command")));
    assert!(!is_standalone_builtin_compact_command(&text("/compact now", "command")));
    assert!(!is_standalone_builtin_compact_command(&text("/compact", "skill")));
    assert!(!is_standalone_builtin_compact_command(&[
        json!({ "type": "text", "text": "/compact", "mentions": [] })
    ]));
}
