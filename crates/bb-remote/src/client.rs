use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use bb_core::{
    RunnerApi, RunnerError, RunnerErrorCode, RunnerEventSink, RunnerResult, SharedRunner,
};
use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::{oneshot, watch};

use crate::link::{Link, link_frames};
use crate::protocol::{Frame, Hello, from_wire_error, is_runner_method, request_timeout_ms};
use crate::socket::WireSocket;

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<RunnerResult<Value>>>>>;

struct RemoteApi {
    link: Arc<Link>,
    pending: Pending,
    lost: Arc<AtomicBool>,
    last_request_id: AtomicU64,
}

#[async_trait]
impl RunnerApi for RemoteApi {
    async fn call(&self, method: &str, params: Value) -> RunnerResult<Value> {
        if !is_runner_method(method) {
            let message = format!("Runner method \"{method}\" cannot be called remotely");
            return Err(RunnerError::failed(message));
        }
        if method == "ackEvents" {
            if let Some(seq) = params.get("seq").and_then(Value::as_u64) {
                self.link.send(&Frame::Ack { seq });
            }
            return Ok(Value::Null);
        }
        if self.lost.load(Ordering::SeqCst) {
            return Err(RunnerError::connection_lost());
        }
        let id = self.last_request_id.fetch_add(1, Ordering::SeqCst) + 1;
        let timeout_ms = request_timeout_ms(method, &params);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id, tx);
        self.link.send(&Frame::Req { id, method: method.to_owned(), params: Some(params) });
        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RunnerError::connection_lost()),
            Err(_) => {
                self.pending.lock().remove(&id);
                let message = format!("Runner did not answer {method} in {timeout_ms} ms");
                Err(RunnerError::retryable(RunnerErrorCode::Unavailable, message))
            }
        }
    }
}

/// The server's end of a runner socket.
pub struct RemoteRunner {
    pub runner: SharedRunner,
    pub link: Arc<Link>,
    hello: watch::Receiver<Option<Hello>>,
    closed: watch::Receiver<bool>,
}

impl RemoteRunner {
    /// The runner's `hello`, or `None` if the socket closed first.
    pub async fn hello(&self) -> Option<Hello> {
        let mut hello = self.hello.clone();
        let mut closed = self.closed.clone();
        tokio::select! {
            hello = hello.wait_for(Option::is_some) => hello.ok().and_then(|hello| hello.clone()),
            _ = closed.wait_for(|closed| *closed) => self.hello.borrow().clone(),
        }
    }

    pub async fn closed(&self) {
        let mut closed = self.closed.clone();
        let _ = closed.wait_for(|closed| *closed).await;
    }

    pub fn welcome(&self, last_seq: u64) {
        self.link.send(&Frame::Welcome { last_seq });
    }
}

pub fn connect_remote_runner(socket: WireSocket, sink: RunnerEventSink) -> RemoteRunner {
    let pending: Pending = Arc::default();
    let lost = Arc::new(AtomicBool::new(false));
    let (hello_tx, hello) = watch::channel(None);
    let (closed_tx, closed) = watch::channel(false);
    let answers = pending.clone();
    let on_frame = move |frame: Frame| match frame {
        Frame::Evt { event } => sink(event),
        Frame::Hello(hello) => {
            hello_tx.send_replace(Some(hello));
        }
        Frame::Res { id, ok, result, error } => {
            if let Some(request) = answers.lock().remove(&id) {
                let outcome = if ok {
                    Ok(result.unwrap_or(Value::Null))
                } else {
                    Err(from_wire_error(error))
                };
                let _ = request.send(outcome);
            }
        }
        _ => {}
    };
    let rejected = pending.clone();
    let mark_lost = lost.clone();
    let on_closed = move || {
        mark_lost.store(true, Ordering::SeqCst);
        for (_, request) in rejected.lock().drain() {
            let _ = request.send(Err(RunnerError::connection_lost()));
        }
        closed_tx.send_replace(true);
    };
    let link = link_frames(socket, true, on_frame, on_closed);
    let api = RemoteApi { link: link.clone(), pending, lost, last_request_id: AtomicU64::new(0) };
    RemoteRunner { runner: Arc::new(api), link, hello, closed }
}
