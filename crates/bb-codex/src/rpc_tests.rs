use super::*;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines};

#[derive(Default)]
struct Recorder {
    notifications: Mutex<Vec<(String, Value)>>,
    exits: Mutex<Vec<ExitInfo>>,
}

impl RpcHandlers for Recorder {
    fn on_notification(&self, method: &str, params: Value) {
        self.notifications.lock().push((method.to_owned(), params));
    }

    fn on_request(&self, rpc: &CodexRpc, id: RequestId, method: &str, params: Value) {
        if method == "item/tool/call" {
            rpc.respond(&id, json!({"echo": params}));
        } else {
            rpc.reject(&id, -32601, &format!("Unhandled codex request \"{method}\""));
        }
    }

    fn on_exit(&self, info: ExitInfo) {
        self.exits.lock().push(info);
    }
}

struct Script {
    requests: Lines<BufReader<DuplexStream>>,
    stdout: DuplexStream,
    stderr: DuplexStream,
    exit: Option<oneshot::Sender<ChildExit>>,
    signals: mpsc::UnboundedReceiver<KillSignal>,
}

impl Script {
    async fn next(&mut self) -> Value {
        let line = self.requests.next_line().await.unwrap().unwrap();
        serde_json::from_str(&line).unwrap()
    }

    async fn send(&mut self, message: Value) {
        self.stdout.write_all(format!("{message}\n").as_bytes()).await.unwrap();
    }
}

fn scripted() -> (AppServerChild, Script) {
    let (stdin, requests) = tokio::io::duplex(1 << 16);
    let (stdout_read, stdout) = tokio::io::duplex(1 << 16);
    let (stderr_read, stderr) = tokio::io::duplex(1 << 16);
    let (exit_tx, exit_rx) = oneshot::channel();
    let (signal_tx, signals) = mpsc::unbounded_channel();
    let child = AppServerChild {
        stdin: Box::new(stdin),
        stdout: Box::new(stdout_read),
        stderr: Box::new(stderr_read),
        exit: Box::pin(async move { exit_rx.await.unwrap_or_default() }),
        signal: Box::new(move |signal| {
            let _ = signal_tx.send(signal);
        }),
    };
    let script = Script {
        requests: BufReader::new(requests).lines(),
        stdout,
        stderr,
        exit: Some(exit_tx),
        signals,
    };
    (child, script)
}

#[tokio::test]
async fn correlates_responses_out_of_order() {
    let (child, mut script) = scripted();
    let rpc = CodexRpc::new(child, Arc::new(Recorder::default()));
    let first = tokio::spawn({
        let rpc = rpc.clone();
        async move { rpc.request("initialize", json!({"a": 1})).await }
    });
    let request = script.next().await;
    assert_eq!(
        request,
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"a": 1}})
    );
    let second = tokio::spawn({
        let rpc = rpc.clone();
        async move { rpc.request("thread/start", json!({})).await }
    });
    assert_eq!(script.next().await["id"], 2);
    script.send(json!({"id": 2, "error": {"code": -1, "message": "nope"}})).await;
    script.send(json!({"id": "1", "result": {"ok": true}})).await;
    assert_eq!(first.await.unwrap().unwrap(), json!({"ok": true}));
    let error = second.await.unwrap().unwrap_err();
    assert_eq!((error.message.as_str(), error.code), ("nope", Some(-1)));
}

#[tokio::test]
async fn delivers_notifications_and_answers_server_requests() {
    let (child, mut script) = scripted();
    let recorder = Arc::new(Recorder::default());
    let _rpc = CodexRpc::new(child, recorder.clone());
    script.send(json!({"method": "turn/started", "params": {"turn": 1}})).await;
    script.send(json!({"id": null, "method": "dropped"})).await;
    script.send(json!({"id": 7, "method": "item/tool/call", "params": {"x": 1}})).await;
    script.send(json!({"id": "s", "method": "other/thing"})).await;
    let answer = script.next().await;
    assert_eq!(answer, json!({"jsonrpc": "2.0", "id": 7, "result": {"echo": {"x": 1}}}));
    let rejected = script.next().await;
    let error = json!({"code": -32601, "message": "Unhandled codex request \"other/thing\""});
    assert_eq!(rejected, json!({"jsonrpc": "2.0", "id": "s", "error": error}));
    let notifications = recorder.notifications.lock().clone();
    assert_eq!(notifications, vec![("turn/started".to_owned(), json!({"turn": 1}))]);
}

#[tokio::test]
async fn exit_fails_pending_requests_with_stderr_tail() {
    let (child, mut script) = scripted();
    let recorder = Arc::new(Recorder::default());
    let rpc = CodexRpc::new(child, recorder.clone());
    let pending = tokio::spawn({
        let rpc = rpc.clone();
        async move { rpc.request("initialize", json!({})).await }
    });
    script.next().await;
    script.stderr.write_all(b"boom\nlast\n").await.unwrap();
    script.stderr.flush().await.unwrap();
    tokio::task::yield_now().await;
    let exit = ChildExit { code: Some(1), signal: None, error: None };
    script.exit.take().unwrap().send(exit).unwrap();
    drop(script.stdout);
    drop(script.stderr);
    let error = pending.await.unwrap().unwrap_err();
    assert_eq!(error.message, "codex app-server exited (code 1, signal null): boom\nlast");
    assert!(rpc.exited());
    let exits = recorder.exits.lock().clone();
    assert_eq!(
        exits,
        vec![ExitInfo { message: error.message.clone(), stderr_tail: "boom\nlast".into() }]
    );
    let after = rpc.request("x", json!({})).await.unwrap_err();
    assert_eq!(after.message, "codex app-server is not running");
}

#[tokio::test]
async fn spawn_failure_is_reported() {
    let child = spawn_app_server(
        "/nonexistent/codex-test",
        &[],
        Launch { cwd: "/".into(), env: EnvMap::new() },
    );
    let rpc = CodexRpc::new(child, Arc::new(Recorder::default()));
    let error = rpc.request("initialize", json!({})).await.unwrap_err();
    assert!(error.spawn_failed);
    assert_eq!(
        error.message,
        "codex app-server exited (code null, signal null): spawn /nonexistent/codex-test ENOENT"
    );
}

#[tokio::test(start_paused = true)]
async fn kill_closes_stdin_then_escalates() {
    let (child, mut script) = scripted();
    let recorder = Arc::new(Recorder::default());
    let rpc = CodexRpc::new(child, recorder.clone());
    let killing = tokio::spawn({
        let rpc = rpc.clone();
        async move { rpc.kill().await }
    });
    assert!(script.requests.next_line().await.unwrap().is_none());
    assert_eq!(script.signals.recv().await, Some(KillSignal::Term));
    assert_eq!(script.signals.recv().await, Some(KillSignal::Kill));
    let exit = ChildExit { code: None, signal: Some("SIGKILL".into()), error: None };
    script.exit.take().unwrap().send(exit).unwrap();
    killing.await.unwrap();
    assert!(rpc.exited());
    assert!(recorder.exits.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn request_times_out() {
    let (child, _script) = scripted();
    let rpc = CodexRpc::new(child, Arc::new(Recorder::default()));
    let error = rpc.request("model/list", json!({})).await.unwrap_err();
    assert_eq!(error.message, "codex app-server did not answer model/list in time");
}
