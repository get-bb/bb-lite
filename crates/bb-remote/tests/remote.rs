use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bb_core::{
    RunnerApi, RunnerError, RunnerErrorCode, RunnerEvent, RunnerEventBody, RunnerEventSink,
    RunnerResult, SharedRunner,
};
use bb_remote::serve::LIVE_OUTPUT_KEEP_NEWEST;
use bb_remote::socket::MemoryEnd;
use bb_remote::{
    Outbox, RemoteRunner, RunnerServing, SocketSend, WireSocket, connect_remote_runner,
    memory_pair, serve_runner,
};
use parking_lot::Mutex;
use serde_json::{Value, json};

const MIB: usize = 1024 * 1024;

struct Fake;

#[async_trait]
impl RunnerApi for Fake {
    async fn call(&self, method: &str, params: Value) -> RunnerResult<Value> {
        match method {
            "describe" => Ok(json!({"instanceId": "rin_1", "version": "0.0.1"})),
            "readFile" => Err(RunnerError::new(RunnerErrorCode::PathNotFound, "missing")),
            "readFileChunk" => Ok(json!({"dataBase64": "A".repeat(700_000)})),
            "renameSession" => Ok(json!({"title": params["title"]})),
            _ => Err(RunnerError::failed(format!("{method} is not faked"))),
        }
    }
}

async fn until<T>(mut check: impl FnMut() -> Option<T>) -> T {
    for _ in 0..2_000 {
        if let Some(value) = check() {
            return value;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("condition not met in time");
}

struct Recording {
    inner: Box<dyn SocketSend>,
    sizes: Arc<Mutex<Vec<usize>>>,
}

#[async_trait]
impl SocketSend for Recording {
    async fn send_text(&mut self, text: String) -> bool {
        self.sizes.lock().push(text.len());
        self.inner.send_text(text).await
    }

    async fn close(&mut self, code: u16, reason: String) {
        self.inner.close(code, reason).await;
    }
}

fn recorded(
    end: MemoryEnd,
    sizes: &Arc<Mutex<Vec<usize>>>,
) -> (WireSocket, tokio::sync::watch::Sender<bool>) {
    let WireSocket { send, recv } = end.socket;
    let send = Box::new(Recording { inner: send, sizes: sizes.clone() });
    (WireSocket { send, recv }, end.pause)
}

struct RawPeer {
    frames: Arc<Mutex<Vec<Value>>>,
    send: Box<dyn SocketSend>,
}

impl RawPeer {
    fn new(socket: WireSocket) -> Self {
        let frames = Arc::new(Mutex::new(Vec::new()));
        let into = frames.clone();
        let WireSocket { send, mut recv } = socket;
        tokio::spawn(async move {
            while let bb_remote::Received::Text(text) = recv.recv().await {
                into.lock().push(serde_json::from_str(&text).unwrap_or(Value::Null));
            }
        });
        Self { frames, send }
    }

    async fn send(&mut self, frame: Value) {
        assert!(self.send.send_text(frame.to_string()).await);
    }

    async fn reply(&self, id: u64) -> Value {
        until(|| {
            let frames = self.frames.lock();
            frames.iter().find(|frame| frame["t"] == "res" && frame["id"] == id).cloned()
        })
        .await
    }
}

fn local_runner() -> (SharedRunner, Arc<Outbox>, Arc<Mutex<Option<RunnerServing>>>) {
    let slot: Arc<Mutex<Option<RunnerServing>>> = Arc::default();
    let into = slot.clone();
    let outbox = Outbox::new(Arc::new(move |event| {
        let serving = into.lock().clone();
        if let Some(serving) = serving {
            serving.deliver(event);
        }
    }));
    (Arc::new(Fake), outbox, slot)
}

#[tokio::test]
async fn serves_only_the_runner_interface_and_maps_errors() {
    let (runner_side, server_side) = memory_pair();
    let mut peer = RawPeer::new(server_side.socket);
    let (runner, outbox, slot) = local_runner();
    *slot.lock() = Some(serve_runner(runner, outbox, runner_side.socket));
    until(|| (!peer.frames.lock().is_empty()).then_some(())).await;
    assert_eq!(
        peer.frames.lock()[0],
        json!({"t": "hello", "instanceId": "rin_1", "version": "0.0.1", "lastAckedSeq": 0})
    );
    for (id, method) in ["shutdown", "outbox", "constructor", "nope", "describe"].iter().enumerate()
    {
        peer.send(json!({"t": "req", "id": id, "method": method})).await;
    }
    peer.send(json!({"t": "req", "id": 9, "method": "readFile", "params": {"path": "absent.txt"}}))
        .await;
    peer.send(json!({"t": "ping"})).await;
    for id in 0..4 {
        let reply = peer.reply(id).await;
        assert_eq!(reply["ok"], false);
        assert_eq!(
            (&reply["error"]["code"], &reply["error"]["retryable"]),
            (&json!("failed"), &json!(false))
        );
    }
    assert_eq!(
        peer.reply(1).await["error"]["message"],
        "Runner method \"outbox\" cannot be called remotely"
    );
    let described = peer.reply(4).await;
    assert_eq!(
        (&described["ok"], &described["result"]["instanceId"]),
        (&json!(true), &json!("rin_1"))
    );
    assert_eq!(peer.reply(9).await["error"]["code"], "path_not_found");
    until(|| peer.frames.lock().contains(&json!({"t": "pong"})).then_some(())).await;
}

#[tokio::test]
async fn rejects_pending_and_later_requests_when_the_socket_drops() {
    let (runner_side, server_side) = memory_pair();
    let peer = RawPeer::new(runner_side.socket);
    let remote = connect_remote_runner(server_side.socket, Arc::new(|_| {}));
    let runner = remote.runner.clone();
    let pending =
        tokio::spawn(async move { runner.call("gitStatus", json!({"path": "/repo"})).await });
    until(|| peer.frames.lock().iter().any(|frame| frame["method"] == "gitStatus").then_some(()))
        .await;
    drop(peer.send);
    let lost = RunnerError::connection_lost();
    assert_eq!(pending.await.unwrap(), Err(lost.clone()));
    remote.closed().await;
    assert_eq!(remote.runner.call("describe", json!({})).await, Err(lost));
}

struct Welcomed {
    outbox: Arc<Outbox>,
    remote: RemoteRunner,
    serving: RunnerServing,
    pause: tokio::sync::watch::Sender<bool>,
    sizes: Arc<Mutex<Vec<usize>>>,
}

async fn welcomed_pair(sink: RunnerEventSink) -> Welcomed {
    let sizes = Arc::default();
    let (runner_end, server_end) = memory_pair();
    let (runner_socket, _) = recorded(runner_end, &sizes);
    let (server_socket, pause) = recorded(server_end, &sizes);
    let (runner, outbox, slot) = local_runner();
    let remote = connect_remote_runner(server_socket, sink);
    let serving = serve_runner(runner, outbox.clone(), runner_socket);
    *slot.lock() = Some(serving.clone());
    assert_eq!(remote.hello().await.map(|hello| hello.instance_id), Some("rin_1".into()));
    remote.welcome(0);
    remote.runner.call("describe", json!({})).await.unwrap();
    Welcomed { outbox, remote, serving, pause, sizes }
}

#[tokio::test]
async fn keeps_every_wire_frame_under_1_mib_for_large_payloads() {
    let events = Arc::new(Mutex::new(Vec::<RunnerEvent>::new()));
    let into = events.clone();
    let pair = welcomed_pair(Arc::new(move |event| into.lock().push(event))).await;
    let chunk = pair.remote.runner.call("readFileChunk", json!({"path": "big.bin"})).await.unwrap();
    assert_eq!(chunk["dataBase64"].as_str().map(str::len), Some(700_000));

    let text = "\u{20ac}".repeat(600_000);
    let renamed =
        pair.remote.runner.call("renameSession", json!({"threadId": "thr_none", "title": text}));
    assert_eq!(renamed.await.unwrap()["title"], json!(text));
    let output = RunnerEventBody::ScriptOutput { operation_id: "op_1".into(), text };
    pair.outbox.emit(output.clone());
    until(|| (!events.lock().is_empty()).then_some(())).await;
    assert_eq!(*events.lock(), [RunnerEvent::reliable(1, output)]);
    let sizes = pair.sizes.lock().clone();
    assert_eq!(sizes.iter().filter(|size| **size > MIB / 2).count(), 7);
    assert!(sizes.iter().all(|size| *size < MIB));
}

#[tokio::test]
async fn sheds_old_terminal_output_under_backpressure_never_the_tail() {
    let seqs = Arc::new(Mutex::new(Vec::new()));
    let exited = Arc::new(Mutex::new(false));
    let (into, done) = (seqs.clone(), exited.clone());
    let pair = welcomed_pair(Arc::new(move |event: RunnerEvent| match event.body {
        RunnerEventBody::TerminalOutput { .. } => into.lock().push(event.seq.unwrap_or(0)),
        body => *done.lock() = body.kind() == "terminal.exited",
    }))
    .await;
    pair.pause.send_replace(true);
    let data = "A".repeat(64 * 1024);
    let total = 400;
    for seq in 1..=total {
        pair.serving.deliver(RunnerEvent::terminal_output("term_1".into(), seq, data.clone()));
    }
    let exit = RunnerEventBody::TerminalExited { terminal_id: "term_1".into(), exit_code: Some(0) };
    pair.serving.deliver(RunnerEvent::unsequenced(exit));
    pair.pause.send_replace(false);
    until(|| (*exited.lock()).then_some(())).await;
    let seqs = seqs.lock().clone();
    let tail = &seqs[seqs.len() - LIVE_OUTPUT_KEEP_NEWEST..];
    assert_eq!(tail.last(), Some(&total));
    assert_eq!(tail[0], total - LIVE_OUTPUT_KEEP_NEWEST as u64 + 1);
    assert!(seqs.len() < total as usize);
    assert!(seqs.windows(2).all(|pair| pair[0] < pair[1]));
}
