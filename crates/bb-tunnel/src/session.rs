use std::collections::HashMap;
use std::error::Error as StdError;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use parking_lot::Mutex;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, MissedTickBehavior, interval_at};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request as WsRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_util::sync::CancellationToken;

use crate::contract::{
    self, Frame, HEARTBEAT_REQUEST, HEARTBEAT_RESPONSE, HeaderPair, OpenHttpFrame, OpenWsFrame,
};

const DEFAULT_HEARTBEAT: Heartbeat =
    Heartbeat { interval: Duration::from_secs(20), deadline: Duration::from_secs(60) };
const HEARTBEAT_LATE_TICK_GRACE: Duration = Duration::from_secs(5);
const UNREGISTERED_PORT_BODY: &str = "this port is not shared";
pub const VIA_TUNNEL_HEADER: &str = "x-bb-via-tunnel";
const SKIP_REQUEST_HEADERS: [&str; 3] = ["host", "content-length", "connection"];
const WS_HANDSHAKE_HEADERS: [&str; 5] = [
    "upgrade",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "sec-websocket-protocol",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunnelMessage {
    Binary(Vec<u8>),
    Text(String),
}

/// The WebSocket to the gate. `recv` must be cancel-safe (it is raced against timers and
/// outgoing frames) and returns `None` once the socket is closed. `close` terminates it.
#[async_trait]
pub trait TunnelSocket: Send + 'static {
    async fn send_binary(&mut self, data: Vec<u8>) -> std::io::Result<()>;
    async fn send_text(&mut self, text: String) -> std::io::Result<()>;
    async fn recv(&mut self) -> Option<TunnelMessage>;
    async fn close(&mut self);
}

#[async_trait]
impl<S> TunnelSocket for WebSocketStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    async fn send_binary(&mut self, data: Vec<u8>) -> std::io::Result<()> {
        self.send(Message::Binary(data.into())).await.map_err(std::io::Error::other)
    }

    async fn send_text(&mut self, text: String) -> std::io::Result<()> {
        self.send(Message::Text(text.into())).await.map_err(std::io::Error::other)
    }

    async fn recv(&mut self) -> Option<TunnelMessage> {
        loop {
            match self.next().await? {
                Ok(Message::Binary(data)) => return Some(TunnelMessage::Binary(data.to_vec())),
                Ok(Message::Text(text)) => return Some(TunnelMessage::Text(text.to_string())),
                Ok(Message::Close(_)) | Err(_) => return None,
                Ok(_) => {}
            }
        }
    }

    async fn close(&mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(1), SinkExt::close(self)).await;
    }
}

pub trait TunnelLog: Send + Sync {
    fn info(&self, _message: &str) {}
    fn warn(&self, message: &str);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedStreamOrigin {
    pub origin: String,
    pub public_origin: String,
    pub host: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamOriginResult {
    Ok(ResolvedStreamOrigin),
    Unregistered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Heartbeat {
    pub interval: Duration,
    pub deadline: Duration,
}

pub type ResolveOrigin = Arc<dyn Fn(Option<&str>) -> StreamOriginResult + Send + Sync>;

pub struct TunnelSessionOptions {
    pub log: Arc<dyn TunnelLog>,
    pub resolve_origin: ResolveOrigin,
    pub heartbeat: Option<Heartbeat>,
}

struct HttpStream {
    meta: OpenHttpFrame,
    chunks: Vec<u8>,
    abort: CancellationToken,
}

enum WsCommand {
    Data(Message),
    Close(u16, String),
}

#[derive(Default)]
struct State {
    http: HashMap<u32, HttpStream>,
    ws: HashMap<u32, mpsc::UnboundedSender<WsCommand>>,
}

struct Shared {
    options: TunnelSessionOptions,
    out: mpsc::UnboundedSender<Vec<u8>>,
    state: Mutex<State>,
    client: Client<HttpConnector, Full<Bytes>>,
}

/// One connected tunnel: owns the gate socket, answers its frames against loopback origins and
/// ends when the socket closes, the heartbeat deadline passes, [`TunnelSession::dispose`] runs or
/// the handle is dropped.
pub struct TunnelSession {
    stop: CancellationToken,
    done: watch::Receiver<bool>,
}

impl TunnelSession {
    /// Starts the session on the current tokio runtime.
    pub fn start<S: TunnelSocket>(socket: S, options: TunnelSessionOptions) -> TunnelSession {
        let (out, out_rx) = mpsc::unbounded_channel();
        let client = Client::builder(TokioExecutor::new()).build(HttpConnector::new());
        let shared = Arc::new(Shared { options, out, state: Mutex::new(State::default()), client });
        let stop = CancellationToken::new();
        let (done_tx, done) = watch::channel(false);
        tokio::spawn(run(shared, socket, out_rx, stop.clone(), done_tx));
        TunnelSession { stop, done }
    }

    /// Aborts every stream, closes the gate socket and stops the heartbeat.
    pub fn dispose(&self) {
        self.stop.cancel();
    }

    /// Resolves once the session has ended for any reason.
    pub async fn closed(&self) {
        let mut done = self.done.clone();
        let _ = done.wait_for(|d| *d).await;
    }
}

impl Drop for TunnelSession {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

async fn run<S: TunnelSocket>(
    shared: Arc<Shared>,
    mut socket: S,
    mut out_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    stop: CancellationToken,
    done: watch::Sender<bool>,
) {
    let heartbeat = shared.options.heartbeat.unwrap_or(DEFAULT_HEARTBEAT);
    let late_tick = heartbeat.interval + HEARTBEAT_LATE_TICK_GRACE;
    let log = shared.options.log.clone();
    let mut last_ack = Instant::now();
    let mut last_tick = Instant::now();
    let mut stall_grace_since_ack = false;
    let mut ticker = interval_at(Instant::now() + heartbeat.interval, heartbeat.interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = stop.cancelled() => {
                socket.close().await;
                break;
            }
            _ = ticker.tick() => {
                let now = Instant::now();
                let tick_gap = now - last_tick;
                last_tick = now;
                if tick_gap > late_tick && !stall_grace_since_ack {
                    log.warn("event loop stalled; restarting the deadline");
                    last_ack = now;
                    stall_grace_since_ack = true;
                } else if now - last_ack > heartbeat.deadline {
                    log.warn("tunnel heartbeat missed; reconnecting");
                    socket.close().await;
                    break;
                }
                let _ = socket.send_text(HEARTBEAT_REQUEST.to_owned()).await;
            }
            Some(bytes) = out_rx.recv() => {
                let _ = socket.send_binary(bytes).await;
            }
            message = socket.recv() => match message {
                None => break,
                Some(TunnelMessage::Text(text)) => {
                    if text == HEARTBEAT_RESPONSE {
                        last_ack = Instant::now();
                        stall_grace_since_ack = false;
                    }
                }
                Some(TunnelMessage::Binary(data)) => match contract::decode_frame(&data) {
                    Ok(frame) => on_frame(&shared, frame),
                    Err(e) => log.warn(&format!("tunnel bad frame: Error: {e}")),
                },
            },
        }
    }
    dispose_streams(&shared);
    let _ = done.send(true);
}

fn dispose_streams(shared: &Shared) {
    let mut state = shared.state.lock();
    for stream in state.http.values() {
        stream.abort.cancel();
    }
    for tx in state.ws.values() {
        let _ = tx.send(WsCommand::Close(1001, "tunnel closed".to_owned()));
    }
    state.http.clear();
    state.ws.clear();
}

fn send(shared: &Shared, frame: &Frame) {
    if let Ok(bytes) = contract::encode_frame(frame) {
        let _ = shared.out.send(bytes);
    }
}

fn close_stream(shared: &Shared, stream_id: u32, code: u16, reason: String) {
    send(shared, &Frame::CloseStream { stream_id, code, reason });
}

fn on_frame(shared: &Arc<Shared>, frame: Frame) {
    match frame {
        Frame::OpenHttp(meta) => {
            let stream_id = meta.stream_id;
            let has_body = meta.has_body;
            let stream = HttpStream { meta, chunks: Vec::new(), abort: CancellationToken::new() };
            shared.state.lock().http.insert(stream_id, stream);
            if !has_body {
                execute_http(shared, stream_id);
            }
        }
        Frame::BodyChunk { stream_id, data } => {
            if let Some(stream) = shared.state.lock().http.get_mut(&stream_id) {
                stream.chunks.extend_from_slice(&data);
            }
        }
        Frame::BodyEnd { stream_id } => execute_http(shared, stream_id),
        Frame::OpenWs(meta) => open_origin_ws(shared, meta),
        Frame::WsData { stream_id, is_binary, data } => {
            if let Some(tx) = shared.state.lock().ws.get(&stream_id) {
                let message = if is_binary {
                    Message::Binary(data.into())
                } else {
                    Message::Text(String::from_utf8_lossy(&data).into_owned().into())
                };
                let _ = tx.send(WsCommand::Data(message));
            }
        }
        Frame::CloseStream { stream_id, code, reason } => {
            let mut state = shared.state.lock();
            if let Some(stream) = state.http.remove(&stream_id) {
                stream.abort.cancel();
                return;
            }
            if let Some(tx) = state.ws.remove(&stream_id) {
                let _ = tx.send(WsCommand::Close(code, reason));
            }
        }
        Frame::RespHead { .. } | Frame::WsOpenAck { .. } => {}
    }
}

/// The headers sent to a loopback origin: hop and length headers and any inbound
/// `x-bb-via-tunnel` are dropped, a public `Origin` is rewritten to the loopback origin, the
/// via-tunnel marker is added and `Host` is set when the target names one. Later duplicates of
/// an exactly equal name replace earlier ones, as keys of a JavaScript object do.
pub fn headers_for_loopback_request(
    headers: &[HeaderPair],
    target: &ResolvedStreamOrigin,
) -> Vec<HeaderPair> {
    let loopback_origin = url::Url::parse(&target.origin)
        .map(|u| u.origin().ascii_serialization())
        .unwrap_or_else(|_| target.origin.clone());
    let mut forwarded: Vec<HeaderPair> = Vec::new();
    let mut set = |name: &str, value: String| match forwarded.iter_mut().find(|(n, _)| n == name) {
        Some(entry) => entry.1 = value,
        None => forwarded.push((name.to_owned(), value)),
    };
    for (name, value) in headers {
        let lower = name.to_lowercase();
        if SKIP_REQUEST_HEADERS.contains(&lower.as_str()) || lower == VIA_TUNNEL_HEADER {
            continue;
        }
        let public_origin = lower == "origin" && *value == target.public_origin;
        set(name, if public_origin { loopback_origin.clone() } else { value.clone() });
    }
    set(VIA_TUNNEL_HEADER, "1".to_owned());
    if let Some(host) = &target.host {
        set("Host", host.clone());
    }
    forwarded
}

fn error_chain(error: &(dyn StdError + 'static)) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(inner) = source {
        let part = inner.to_string();
        if !text.contains(&part) {
            text.push_str(": ");
            text.push_str(&part);
        }
        source = inner.source();
    }
    format!("Error: {text}")
}

fn path_without_query(path: &str) -> &str {
    path.split('?').next().unwrap_or(path)
}

fn execute_http(shared: &Arc<Shared>, stream_id: u32) {
    let Some((meta, body, abort)) = shared.state.lock().http.get(&stream_id).map(|s| {
        let body = s.meta.has_body.then(|| Bytes::from(s.chunks.clone()));
        (s.meta.clone(), body, s.abort.clone())
    }) else {
        return;
    };
    let resolved = match (shared.options.resolve_origin)(meta.target.as_deref()) {
        StreamOriginResult::Unregistered => {
            let headers = vec![("content-type".to_owned(), "text/plain; charset=utf-8".to_owned())];
            send(shared, &Frame::RespHead { stream_id, status: 404, headers });
            send(
                shared,
                &Frame::BodyChunk { stream_id, data: UNREGISTERED_PORT_BODY.as_bytes().to_vec() },
            );
            send(shared, &Frame::BodyEnd { stream_id });
            shared.state.lock().http.remove(&stream_id);
            return;
        }
        StreamOriginResult::Ok(resolved) => resolved,
    };
    let headers = headers_for_loopback_request(&meta.headers, &resolved);
    let shared = shared.clone();
    tokio::spawn(async move {
        let result = tokio::select! {
            result = proxy_http(&shared, stream_id, &resolved, &meta, headers, body) => result,
            _ = abort.cancelled() => Ok(()),
        };
        if let Err(e) = result
            && !abort.is_cancelled()
        {
            let path = path_without_query(&meta.path);
            shared.options.log.warn(&format!("origin http error on {} {path}: {e}", meta.method));
            close_stream(&shared, stream_id, 1011, e);
        }
        shared.state.lock().http.remove(&stream_id);
    });
}

async fn proxy_http(
    shared: &Shared,
    stream_id: u32,
    resolved: &ResolvedStreamOrigin,
    meta: &OpenHttpFrame,
    headers: Vec<HeaderPair>,
    body: Option<Bytes>,
) -> Result<(), String> {
    let base = resolved.origin.strip_suffix('/').unwrap_or(&resolved.origin);
    let url = url::Url::parse(&format!("{base}{}", meta.path))
        .map_err(|_| "TypeError: Invalid URL".to_owned())?;
    let mut request = hyper::Request::builder().method(meta.method.as_str()).uri(url.as_str());
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(body) = &body {
        request = request.header("Content-Length", body.len().to_string());
    }
    let request = request.body(Full::new(body.unwrap_or_default())).map_err(|e| error_chain(&e))?;
    let response = shared.client.request(request).await.map_err(|e| error_chain(&e))?;
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
            (name.as_str().to_owned(), value)
        })
        .collect();
    send(shared, &Frame::RespHead { stream_id, status: response.status().as_u16(), headers });
    let mut body = response.into_body();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| error_chain(&e))?;
        if let Ok(data) = frame.into_data() {
            for chunk in contract::chunk_body(stream_id, &data) {
                send(shared, &chunk);
            }
        }
    }
    send(shared, &Frame::BodyEnd { stream_id });
    Ok(())
}

fn origin_ws_request(
    meta: &OpenWsFrame,
    resolved: &ResolvedStreamOrigin,
) -> Result<WsRequest, String> {
    let origin = match resolved.origin.strip_prefix("http") {
        Some(rest) => format!("ws{rest}"),
        None => resolved.origin.clone(),
    };
    let url = format!("{origin}{}", meta.path);
    let mut request = url.into_client_request().map_err(|e| error_chain(&e))?;
    let target = request.headers_mut();
    for (name, value) in headers_for_loopback_request(&meta.headers, resolved) {
        if WS_HANDSHAKE_HEADERS.contains(&name.to_lowercase().as_str()) {
            continue;
        }
        let name = http::HeaderName::from_bytes(name.as_bytes()).map_err(|e| error_chain(&e))?;
        let value = http::HeaderValue::from_str(&value).map_err(|e| error_chain(&e))?;
        if name == http::header::HOST {
            target.insert(name, value);
        } else {
            target.append(name, value);
        }
    }
    if !meta.protocols.is_empty() {
        let protocols = http::HeaderValue::from_str(&meta.protocols.join(","))
            .map_err(|_| "SyntaxError: An invalid or duplicated subprotocol was specified")?;
        target.insert(http::header::SEC_WEBSOCKET_PROTOCOL, protocols);
    }
    Ok(request)
}

fn open_origin_ws(shared: &Arc<Shared>, meta: OpenWsFrame) {
    let stream_id = meta.stream_id;
    let resolved = match (shared.options.resolve_origin)(meta.target.as_deref()) {
        StreamOriginResult::Unregistered => {
            return close_stream(shared, stream_id, 1008, UNREGISTERED_PORT_BODY.to_owned());
        }
        StreamOriginResult::Ok(resolved) => resolved,
    };
    let request = match origin_ws_request(&meta, &resolved) {
        Ok(request) => request,
        Err(e) => return close_stream(shared, stream_id, 1011, e),
    };
    let (tx, rx) = mpsc::unbounded_channel();
    shared.state.lock().ws.insert(stream_id, tx);
    let path = path_without_query(&meta.path).to_owned();
    tokio::spawn(relay_ws(shared.clone(), stream_id, path, request, rx));
}

fn finish_ws(shared: &Shared, stream_id: u32, code: u16, reason: String) {
    let relayed = code == 1000 || (3000..=4999).contains(&code);
    if shared.state.lock().ws.remove(&stream_id).is_some() {
        close_stream(shared, stream_id, if relayed { code } else { 1000 }, reason);
    }
}

async fn relay_ws(
    shared: Arc<Shared>,
    stream_id: u32,
    path: String,
    request: WsRequest,
    mut rx: mpsc::UnboundedReceiver<WsCommand>,
) {
    let warn = |message: String| {
        shared.options.log.warn(&format!("origin ws error on {path}: {message}"));
    };
    let mut buffered = Vec::new();
    let connect = tokio_tungstenite::connect_async(request);
    tokio::pin!(connect);
    let connected = loop {
        tokio::select! {
            result = &mut connect => break result,
            command = rx.recv() => match command {
                Some(WsCommand::Data(message)) => buffered.push(message),
                Some(WsCommand::Close(..)) | None => {
                    warn("WebSocket was closed before the connection was established".to_owned());
                    return;
                }
            },
        }
    };
    let mut socket = match connected {
        Ok((socket, response)) => {
            let protocol = response
                .headers()
                .get(http::header::SEC_WEBSOCKET_PROTOCOL)
                .and_then(|v| v.to_str().ok())
                .filter(|v| !v.is_empty())
                .map(str::to_owned);
            send(&shared, &Frame::WsOpenAck { stream_id, protocol });
            socket
        }
        Err(e) => {
            warn(error_chain(&e).trim_start_matches("Error: ").to_owned());
            return finish_ws(&shared, stream_id, 1006, String::new());
        }
    };
    for message in buffered {
        let _ = socket.send(message).await;
    }
    loop {
        tokio::select! {
            command = rx.recv() => match command {
                Some(WsCommand::Data(message)) => {
                    let _ = socket.send(message).await;
                }
                Some(WsCommand::Close(code, reason)) => {
                    let frame = CloseFrame { code: code.into(), reason: reason.into() };
                    let _ = socket.close(Some(frame)).await;
                    drain(&mut socket).await;
                    return;
                }
                None => {
                    drain(&mut socket).await;
                    return;
                }
            },
            message = socket.next() => match message {
                Some(Ok(Message::Text(text))) => send(
                    &shared,
                    &Frame::WsData { stream_id, is_binary: false, data: text.as_bytes().to_vec() },
                ),
                Some(Ok(Message::Binary(data))) => send(
                    &shared,
                    &Frame::WsData { stream_id, is_binary: true, data: data.to_vec() },
                ),
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = match frame {
                        Some(f) => (u16::from(f.code), f.reason.to_string()),
                        None => (1005, String::new()),
                    };
                    finish_ws(&shared, stream_id, code, reason);
                    drain(&mut socket).await;
                    return;
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => {
                    warn(error_chain(&e).trim_start_matches("Error: ").to_owned());
                    return finish_ws(&shared, stream_id, 1006, String::new());
                }
                None => return finish_ws(&shared, stream_id, 1006, String::new()),
            },
        }
    }
}

async fn drain<S>(socket: &mut WebSocketStream<S>)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        while socket.next().await.is_some() {}
    })
    .await;
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
