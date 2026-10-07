use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Weak};

use async_trait::async_trait;
use axum::extract::ws::{CloseFrame, Message, WebSocket};
use bb_core::{Lane, RunnerApi, RunnerError, RunnerErrorCode, RunnerEventSink, RunnerResult};
use bb_remote::protocol::REPLACED_CLOSE_CODE;
use bb_remote::{Hello, Received, SocketRecv, SocketSend, WireSocket, connect_remote_runner};
use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{Value, json};

use crate::context::{Ctx, ServerContext};
use crate::db::Db;
use crate::db::hosts::{HostLookup, advance_host_event_cursor, find_host, update_host};
use crate::runners::registry::Registration;

const INTERNAL_ERROR_CLOSE_CODE: u16 = 1011;
const LAST_SEEN_INTERVAL_MS: i64 = 30_000;

struct EventStream {
    instance_id: String,
    delivered_seq: u64,
}

type SharedStream = Arc<Mutex<EventStream>>;
type HostStreams = HashMap<String, SharedStream>;
type StreamsByServer = Vec<(Weak<ServerContext>, HostStreams)>;

static STREAMS: LazyLock<Mutex<StreamsByServer>> = LazyLock::new(Mutex::default);

fn with_streams<T>(ctx: &Ctx, work: impl FnOnce(&mut HostStreams) -> T) -> T {
    let mut all = STREAMS.lock();
    all.retain(|(owner, _)| owner.strong_count() > 0);
    let index = match all.iter().position(|(owner, _)| owner.as_ptr() == Arc::as_ptr(ctx)) {
        Some(index) => index,
        None => {
            all.push((Arc::downgrade(ctx), HashMap::new()));
            all.len() - 1
        }
    };
    work(&mut all[index].1)
}

fn resume_stream(ctx: &Ctx, host_id: &str, hello: &Hello) -> Result<SharedStream, String> {
    let instance_id = hello.instance_id.as_str();
    let live = with_streams(ctx, |streams| streams.get(host_id).cloned());
    if let Some(live) = live.filter(|live| live.lock().instance_id == instance_id) {
        return Ok(live);
    }
    let stored = find_host(&ctx.db, HostLookup::Id, host_id)
        .map_err(|error| error.to_string())?
        .ok_or("Host was removed")?;
    let known = stored.last_instance_id.as_deref() == Some(instance_id);
    let delivered_seq = if known {
        u64::try_from(stored.last_event_seq).unwrap_or(0)
    } else {
        hello.last_acked_seq.unwrap_or(0)
    };
    if !known {
        let cursor = crate::row! {
            "lastInstanceId" => instance_id,
            "lastEventSeq" => i64::try_from(delivered_seq).unwrap_or(i64::MAX),
        };
        update_host(&ctx.db, host_id, &cursor).map_err(|error| error.to_string())?;
    }
    let stream =
        Arc::new(Mutex::new(EventStream { instance_id: instance_id.to_owned(), delivered_seq }));
    with_streams(ctx, |streams| streams.insert(host_id.to_owned(), stream.clone()));
    Ok(stream)
}

/// The remote runner as the server uses it: `ackEvents` first advances
/// `hosts.last_event_seq`, then reaches the machine.
struct AckingRunner {
    remote: bb_core::SharedRunner,
    db: Db,
    host_id: String,
    instance_id: String,
}

#[async_trait]
impl RunnerApi for AckingRunner {
    async fn call(&self, method: &str, params: Value) -> RunnerResult<Value> {
        if method == "ackEvents" {
            let seq = params.get("seq").and_then(Value::as_i64).unwrap_or(0);
            advance_host_event_cursor(&self.db, &self.host_id, &self.instance_id, seq).map_err(
                |error| RunnerError::new(RunnerErrorCode::Unavailable, error.to_string()),
            )?;
        }
        self.remote.call(method, params).await
    }
}

struct SeenRecv {
    inner: Box<dyn SocketRecv>,
    ctx: Ctx,
    host_id: String,
    seen_at: i64,
}

#[async_trait]
impl SocketRecv for SeenRecv {
    async fn recv(&mut self) -> Received {
        let received = self.inner.recv().await;
        if matches!(received, Received::Text(_))
            && self.ctx.now() - self.seen_at >= LAST_SEEN_INTERVAL_MS
        {
            self.seen_at = self.ctx.now();
            let patch = crate::row! { "lastSeenAt" => self.seen_at };
            if let Err(error) = update_host(&self.ctx.db, &self.host_id, &patch) {
                let fields = json!({ "err": error.to_string(), "hostId": self.host_id });
                self.ctx.log.error("Remote runner last-seen update failed", fields);
            }
        }
        received
    }
}

type DeliverSlot = Arc<Mutex<Option<RunnerEventSink>>>;

/// Serves a runner that dialled `/internal/runner/ws` as `host_id`.
pub fn attach_remote_runner(ctx: &Ctx, host_id: &str, socket: WireSocket) {
    let WireSocket { send, recv } = socket;
    let recv = SeenRecv { inner: recv, ctx: ctx.clone(), host_id: host_id.to_owned(), seen_at: 0 };
    let socket = WireSocket { send, recv: Box::new(recv) };
    let deliver: DeliverSlot = Arc::default();
    let deliver_events = deliver.clone();
    let sink: RunnerEventSink = Arc::new(move |event| {
        let current = deliver_events.lock().clone();
        if let Some(current) = current {
            current(event);
        }
    });
    let remote = Arc::new(connect_remote_runner(socket, sink));
    let ctx = ctx.clone();
    let host_id = host_id.to_owned();
    tokio::spawn(async move {
        let link = remote.link.clone();
        if let Err(error) = run_connection(&ctx, &host_id, &remote, deliver).await {
            let fields = json!({ "err": error, "hostId": host_id });
            ctx.log.warn("Remote runner handshake failed", fields);
            link.close(INTERNAL_ERROR_CLOSE_CODE, "runner handshake failed");
        }
    });
}

async fn run_connection(
    ctx: &Ctx,
    host_id: &str,
    remote: &Arc<bb_remote::RemoteRunner>,
    deliver: DeliverSlot,
) -> Result<(), String> {
    let Some(hello) = remote.hello().await else { return Ok(()) };
    let info = remote.runner.call("describe", json!({})).await.map_err(|error| error.message)?;
    let stream = resume_stream(ctx, host_id, &hello)?;
    let field = |key: &str| info.get(key).and_then(Value::as_str).map(str::to_owned);
    let patch = crate::row! {
        "platform" => field("platform"),
        "threadStorageRoot" => field("threadStorageRoot"),
    };
    update_host(&ctx.db, host_id, &patch).map_err(|error| error.to_string())?;
    let instance_id = stream.lock().instance_id.clone();
    let runner: bb_core::SharedRunner = Arc::new(AckingRunner {
        remote: remote.runner.clone(),
        db: ctx.db.clone(),
        host_id: host_id.to_owned(),
        instance_id: instance_id.clone(),
    });
    let factory_runner = runner.clone();
    let factory_deliver = deliver.clone();
    let factory_stream = stream.clone();
    ctx.runners.connect(
        host_id,
        Box::new(move |sink| {
            let filtered: RunnerEventSink = Arc::new(move |event| {
                if event.lane == Lane::Reliable {
                    let seq = event.seq.unwrap_or(0);
                    let mut stream = factory_stream.lock();
                    if seq <= stream.delivered_seq {
                        return;
                    }
                    stream.delivered_seq = seq;
                }
                sink(event);
            });
            *factory_deliver.lock() = Some(filtered);
            factory_runner
        }),
    );
    let watched_host = host_id.to_owned();
    let link = remote.link.clone();
    let off_disconnected: Registration =
        ctx.runners.on_disconnected(Arc::new(move |disconnected: &str| {
            if disconnected != watched_host {
                return;
            }
            *deliver.lock() = None;
            link.close(REPLACED_CLOSE_CODE, "replaced or removed");
        }));
    let version = hello.version.as_str();
    let fields = json!({ "hostId": host_id, "instanceId": instance_id, "version": version });
    ctx.log.info("Remote runner connected", fields);
    let delivered_seq = stream.lock().delivered_seq;
    remote.welcome(delivered_seq);
    remote.closed().await;
    off_disconnected.remove();
    ctx.runners.disconnect(host_id, Some(&runner));
    Ok(())
}

pub struct AxumSend(SplitSink<WebSocket, Message>);
pub struct AxumRecv(SplitStream<WebSocket>);

#[async_trait]
impl SocketSend for AxumSend {
    async fn send_text(&mut self, text: String) -> bool {
        self.0.send(Message::Text(text.into())).await.is_ok()
    }

    async fn close(&mut self, code: u16, reason: String) {
        let frame = CloseFrame { code, reason: reason.into() };
        let _ = self.0.send(Message::Close(Some(frame))).await;
    }
}

#[async_trait]
impl SocketRecv for AxumRecv {
    async fn recv(&mut self) -> Received {
        loop {
            match self.0.next().await {
                Some(Ok(Message::Text(text))) => return Received::Text(text.to_string()),
                Some(Ok(Message::Binary(bytes))) => {
                    return Received::Text(String::from_utf8_lossy(&bytes).into_owned());
                }
                Some(Ok(Message::Close(frame))) => {
                    return Received::Closed(frame.map(|frame| frame.code));
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                Some(Err(_)) | None => return Received::Closed(None),
            }
        }
    }
}

/// Adapts an upgraded axum WebSocket to the runner wire.
pub fn axum_wire_socket(socket: WebSocket) -> WireSocket {
    let (send, recv) = socket.split();
    WireSocket::new(AxumSend(send), AxumRecv(recv))
}
