use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use bb_core::api::RUNNER_METHODS;
use bb_core::{RunnerApi, RunnerErrorCode, RunnerEvent, RunnerEventBody, SharedRunner};
use bb_remote::{RunnerServing, connect_remote_runner, memory_pair, serve_runner};
use bb_runner::{LocalRunner, LocalRunnerOptions, create_local_runner, default_adapters};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tempfile::TempDir;

const THREAD: &str = "thr_runner1";

type Received = Arc<Mutex<Vec<RunnerEvent>>>;

struct Kit {
    runner: Arc<LocalRunner>,
    received: Received,
    data_dir: TempDir,
    work: TempDir,
}

fn kit() -> Kit {
    let data_dir = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let received: Received = Arc::default();
    let into = received.clone();
    let runner = create_local_runner(LocalRunnerOptions {
        data_dir: data_dir.path().to_path_buf(),
        server_url: "http://127.0.0.1:48901".into(),
        bb_cli_path: "/opt/bb/bin/bb".into(),
        sink: Arc::new(move |event| into.lock().push(event)),
        adapters: default_adapters(),
    });
    Kit { runner: Arc::new(runner), received, data_dir, work }
}

async fn until<T>(mut probe: impl FnMut() -> Option<T>) -> T {
    for _ in 0..3_000 {
        if let Some(value) = probe() {
            return value;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("condition never held");
}

fn thread_events(received: &Received) -> Vec<Value> {
    let received = received.lock();
    let batches = received.iter().filter_map(|event| match &event.body {
        RunnerEventBody::ThreadEvents { events, .. } => {
            assert!(event.seq.is_some(), "thread.events must be reliable");
            Some(events.clone())
        }
        _ => None,
    });
    batches.flatten().collect()
}

fn of_type(received: &Received, kind: &str) -> Vec<Value> {
    thread_events(received).into_iter().filter(|event| event["type"] == kind).collect()
}

fn of_kind(received: &Received, kind: &str) -> Vec<Value> {
    let received = received.lock();
    let matching = received.iter().filter(|event| event.body.kind() == kind);
    matching.map(|event| serde_json::to_value(&event.body).unwrap()).collect()
}

async fn completed(received: &Received, count: usize) {
    until(|| (of_type(received, "turn/completed").len() >= count).then_some(())).await;
}

fn turn(cwd: &Path, text: &str, request: usize) -> Value {
    json!({
        "session": {
            "threadId": THREAD, "providerId": "echo", "cwd": cwd.to_string_lossy(),
            "providerThreadId": null, "instructions": "",
            "dynamicTools": [{
                "name": "lookup", "description": "Looks something up",
                "inputSchema": { "type": "object" }
            }],
            "env": {}, "skillDirs": []
        },
        "clientRequestId": format!("req-{request}"),
        "input": [{ "type": "text", "text": text, "mentions": [] }],
        "options": {
            "model": "echo-1", "reasoningLevel": "medium", "serviceTier": "default",
            "permissionMode": "accept-edits", "permissionEscalation": "ask", "providerOptions": {}
        },
        "mode": { "kind": "auto" },
    })
}

fn mentions(received: &Received, text: &str) -> bool {
    thread_events(received).iter().any(|event| event.to_string().contains(text))
}

fn git(cwd: &Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
        .args(["-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?} failed");
}

fn repo(root: &Path) -> String {
    std::fs::write(root.join("README.md"), "hello\n").unwrap();
    git(root, &["init", "-q"]);
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "init"]);
    root.to_string_lossy().into_owned()
}

#[tokio::test]
async fn every_runner_method_is_handled() {
    let kit = kit();
    assert_eq!(RUNNER_METHODS.len(), 43);
    for (method, _) in RUNNER_METHODS {
        let result = kit.runner.call(method, json!(42)).await;
        if let Err(error) = result {
            assert!(!error.message.contains("Unknown runner method"), "{method}: {error}");
        }
    }
    let unknown = kit.runner.call("launchRockets", json!({})).await.unwrap_err();
    assert_eq!(unknown.code, RunnerErrorCode::Failed);
    assert_eq!(unknown.message, "Unknown runner method: launchRockets");
    let invalid = kit.runner.call("readFile", json!({ "path": 7 })).await.unwrap_err();
    assert_eq!(invalid.code, RunnerErrorCode::Failed);
    assert!(invalid.message.starts_with("Invalid parameters for readFile"), "{invalid}");
    kit.runner.shutdown().await;
}

#[tokio::test]
async fn echo_turns_tool_calls_and_approvals_through_call() {
    let kit = kit();
    let runner = &kit.runner;
    let started = runner.call("submitTurn", turn(kit.work.path(), "hello", 1)).await.unwrap();
    assert_eq!(started["outcome"], "started");
    completed(&kit.received, 1).await;
    until(|| mentions(&kit.received, "Response to: hello").then_some(())).await;

    runner.call("submitTurn", turn(kit.work.path(), "call_tool:lookup", 2)).await.unwrap();
    let request = until(|| of_kind(&kit.received, "toolCall.requested").first().cloned()).await;
    assert_eq!(request["tool"], "lookup");
    let result =
        json!({ "contentItems": [{ "type": "inputText", "text": "found" }], "success": true });
    let resolved =
        json!({ "threadId": THREAD, "requestId": request["requestId"], "result": result });
    runner.call("resolveToolCall", resolved).await.unwrap();
    completed(&kit.received, 2).await;
    until(|| mentions(&kit.received, "Tool called: lookup").then_some(())).await;

    runner.call("submitTurn", turn(kit.work.path(), "approve ship", 3)).await.unwrap();
    let asked = until(|| of_kind(&kit.received, "interaction.requested").first().cloned()).await;
    let resolution = json!({ "decision": "allow_once", "grantedPermissions": null });
    let answer =
        json!({ "threadId": THREAD, "requestId": asked["requestId"], "resolution": resolution });
    runner.call("resolveInteraction", answer).await.unwrap();
    completed(&kit.received, 3).await;
    until(|| mentions(&kit.received, "Response to: approve ship").then_some(())).await;

    let snapshot = runner.call("snapshot", Value::Null).await.unwrap();
    assert_eq!(snapshot["sessions"][0]["threadId"], THREAD);
    runner.shutdown().await;
}

#[tokio::test]
async fn workspace_methods_through_call() {
    let kit = kit();
    let runner = &kit.runner;
    let root = repo(kit.work.path());

    let inspected = runner.call("inspectPath", json!({ "path": root })).await.unwrap();
    assert_eq!(inspected["isGitRepo"], true);
    assert_eq!(inspected["branchName"], "main");

    let file = format!("{root}/notes.txt");
    let written = runner.call("writeFile", json!({ "path": file, "content": "one\n" })).await;
    assert!(written.unwrap()["sha256"].is_string());
    let read = runner.call("readFile", json!({ "path": file })).await.unwrap();
    assert_eq!(read["content"], "one\n");

    let status = runner.call("gitStatus", json!({ "path": root })).await.unwrap();
    assert!(status.to_string().contains("notes.txt"), "{status}");

    let listing = json!({
        "rootPath": root, "limit": 10, "includeFiles": true, "includeDirectories": true
    });
    let listed = runner.call("listPaths", listing).await.unwrap();
    assert!(listed.to_string().contains("README.md"), "{listed}");
    let missing = format!("{root}/missing");
    let exist = runner.call("pathsExist", json!({ "paths": [file, missing] })).await.unwrap();
    assert!(exist.to_string().contains("notes.txt"), "{exist}");

    let mkdir = json!({ "op": "mkdir", "path": format!("{root}/dir"), "recursive": true });
    assert_eq!(runner.call("mutatePath", mkdir).await.unwrap(), json!({ "ok": true }));
    let personal = runner.call("ensurePersonalWorkspace", json!({ "key": "me" })).await.unwrap();
    assert!(personal["path"].as_str().unwrap().ends_with("/me"), "{personal}");

    let create = json!({ "sourcePath": root, "key": "wt-one", "branchName": "feature/one" });
    let worktree = runner.call("createWorktree", create).await.unwrap();
    let path = worktree["path"].as_str().unwrap().to_owned();
    assert!(path.starts_with(&kit.data_dir.path().to_string_lossy().into_owned()), "{path}");
    assert_eq!(worktree["branchName"], "feature/one");
    assert!(Path::new(&path).join("README.md").exists());
    let removed = runner.call("removeWorktree", json!({ "path": path })).await.unwrap();
    assert_eq!(removed, Value::Null);
    assert!(!Path::new(&path).exists());

    let open = json!({
        "terminalId": "term_1", "cwd": root, "cols": 80, "rows": 24,
        "start": { "mode": "shell" }, "env": {}
    });
    runner.call("openTerminal", open).await.unwrap();
    assert_eq!(runner.terminal_ids(), ["term_1"]);
    let typed = BASE64.encode("echo marker-$((40+2))\n");
    let write = json!({ "terminalId": "term_1", "dataBase64": typed });
    assert_eq!(runner.call("writeTerminal", write).await.unwrap(), Value::Null);
    until(|| {
        let received = kit.received.lock();
        let mut output = Vec::new();
        for event in received.iter() {
            if let RunnerEventBody::TerminalOutput { data_base64, .. } = &event.body {
                output.extend(BASE64.decode(data_base64).unwrap());
            }
        }
        String::from_utf8_lossy(&output).contains("marker-42").then_some(())
    })
    .await;
    runner.call("closeTerminal", json!({ "terminalId": "term_1" })).await.unwrap();
    until(|| runner.terminal_ids().is_empty().then_some(())).await;

    std::fs::write(format!("{root}/.bb-env-setup.sh"), "echo setting-up\n").unwrap();
    let script = json!({
        "operationId": "op_1", "path": root, "kind": "setup", "timeoutMs": 10_000, "env": {}
    });
    let ran = runner.call("runLifecycleScript", script).await.unwrap();
    assert_eq!(ran["ran"], true);
    assert_eq!(ran["exitCode"], 0);
    let output = until(|| {
        let received = kit.received.lock();
        let found = received.iter().find(|event| {
            matches!(&event.body, RunnerEventBody::ScriptOutput { text, .. } if text.contains("setting-up"))
        });
        found.cloned()
    })
    .await;
    assert!(output.seq.is_some(), "script.output must go through the outbox");

    let watch = json!({ "generation": 1, "workspaces": [root], "directories": [] });
    assert_eq!(runner.call("setWatchedPaths", watch).await.unwrap(), Value::Null);
    runner.shutdown().await;
}

#[tokio::test]
async fn serves_the_local_runner_over_the_wire() {
    let kit = kit();
    let slot: Arc<Mutex<Option<RunnerServing>>> = Arc::default();
    let into = slot.clone();
    let data_dir = tempfile::tempdir().unwrap();
    let local = create_local_runner(LocalRunnerOptions {
        data_dir: data_dir.path().to_path_buf(),
        server_url: "http://127.0.0.1:48901".into(),
        bb_cli_path: "/opt/bb/bin/bb".into(),
        sink: Arc::new(move |event| {
            let serving = into.lock().clone();
            if let Some(serving) = serving {
                serving.deliver(event);
            }
        }),
        adapters: default_adapters(),
    });
    let parts = local.into_local_parts();
    let (runner_end, server_end) = memory_pair();
    let received = kit.received.clone();
    let remote = connect_remote_runner(
        server_end.socket,
        Arc::new(move |event: RunnerEvent| received.lock().push(event)),
    );
    let serving = serve_runner(parts.runner.clone(), parts.outbox.clone(), runner_end.socket);
    *slot.lock() = Some(serving);
    let hello = remote.hello().await.unwrap();
    let described = parts.runner.call("describe", json!({})).await.unwrap();
    assert_eq!(described["instanceId"], hello.instance_id);
    remote.welcome(0);
    let runner: SharedRunner = remote.runner.clone();

    runner.call("submitTurn", turn(kit.work.path(), "over the wire", 1)).await.unwrap();
    completed(&kit.received, 1).await;
    until(|| mentions(&kit.received, "Response to: over the wire").then_some(())).await;

    let file = kit.work.path().join("remote.txt");
    std::fs::write(&file, "from afar").unwrap();
    let read = runner.call("readFile", json!({ "path": file.to_string_lossy() })).await.unwrap();
    assert_eq!(read["content"], "from afar");
    (parts.shutdown)().await;
}
