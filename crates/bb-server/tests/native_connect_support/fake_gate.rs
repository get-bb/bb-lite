use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use bb_connect::Link;
use bb_tunnel::contract::{HEARTBEAT_REQUEST, HEARTBEAT_RESPONSE, TUNNEL_REPLACED_CLOSE_REASON};
use bb_tunnel::{Frame, OpenHttpFrame, OpenWsFrame, chunk_body, decode_frame, encode_frame};
use parking_lot::Mutex;
use serde_json::json;
use tokio::sync::mpsc;

const MACHINE_HEADER: &str = "x-bb-connect-machine";
const GATE_HEADERS: [&str; 3] = ["x-bb-gate-auth", "x-bb-gate-machine-id", MACHINE_HEADER];
const PUBLIC_PATHS: [&str; 3] = ["/install.sh", "/install/version", "/install/bb-app.tgz"];

fn is_hop(name: &str) -> bool {
    matches!(
        name,
        "connection"
            | "keep-alive"
            | "transfer-encoding"
            | "upgrade"
            | "expect"
            | "host"
            | "sec-websocket-key"
            | "sec-websocket-version"
            | "sec-websocket-extensions"
            | "x-bb-tunnel-target"
    )
}

struct Admission {
    auth: Option<&'static str>,
    machine_id: Option<String>,
}

/// A fake hosted gate on loopback: the account API, the tunnel socket and HTTP forwarding.
pub struct FakeGate {
    pub apex_url: String,
    pub gate_url: String,
    pub credential: Mutex<String>,
    pub ack_heartbeats: AtomicBool,
    pub tunnels_accepted: AtomicUsize,
    pub machines: Mutex<HashMap<String, String>>,
    pub polls: AtomicUsize,
    /// Machine ids revoked through `/api/connect/revoke-machine`, in order.
    pub revoked: Mutex<Vec<String>>,
    pub disconnects: AtomicUsize,
    minted: AtomicUsize,
    tunnel: Mutex<Option<(usize, mpsc::UnboundedSender<Message>)>>,
    pending: Mutex<HashMap<u32, mpsc::UnboundedSender<Frame>>>,
    stream_id: AtomicU32,
}

impl FakeGate {
    pub fn link(&self) -> Link {
        Link {
            base_url: self.apex_url.clone(),
            server_url: self.gate_url.clone(),
            server_id: "srv_1".to_string(),
            server_label: "bee".to_string(),
            credential: self.credential.lock().clone(),
        }
    }

    pub fn tunnels(&self) -> usize {
        self.tunnels_accepted.load(Ordering::SeqCst)
    }

    fn send(&self, frame: &Frame) {
        if let (Some((_, tx)), Ok(bytes)) = (&*self.tunnel.lock(), encode_frame(frame)) {
            let _ = tx.send(Message::Binary(bytes.into()));
        }
    }

    fn admit(&self, method: &str, path: &str, headers: &HeaderMap) -> Result<Admission, u16> {
        let none = Admission { auth: None, machine_id: None };
        if method == "GET" && PUBLIC_PATHS.contains(&path) {
            return Ok(none);
        }
        let machine_path =
            path.starts_with("/internal") || path == "/api/v1" || path.starts_with("/api/v1/");
        if let (true, Some(presented)) = (machine_path, headers.get(MACHINE_HEADER)) {
            let presented = presented.to_str().unwrap_or_default();
            return match self.machines.lock().get(presented) {
                Some(id) => Ok(Admission { auth: Some("machine"), machine_id: Some(id.clone()) }),
                None => Err(403),
            };
        }
        if path.starts_with("/internal") {
            return Err(403);
        }
        match headers.get(header::COOKIE).and_then(|v| v.to_str().ok()) {
            Some("session=owner") => Ok(Admission { auth: Some("session"), machine_id: None }),
            _ => Err(401),
        }
    }
}

pub async fn start_fake_gate() -> Arc<FakeGate> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let gate = Arc::new(FakeGate {
        apex_url: format!("http://localhost:{port}"),
        gate_url: format!("http://127.0.0.1:{port}"),
        credential: Mutex::new("bbcred_first".to_string()),
        ack_heartbeats: AtomicBool::new(true),
        tunnels_accepted: AtomicUsize::new(0),
        machines: Mutex::new(HashMap::new()),
        polls: AtomicUsize::new(0),
        revoked: Mutex::new(Vec::new()),
        disconnects: AtomicUsize::new(0),
        minted: AtomicUsize::new(0),
        tunnel: Mutex::new(None),
        pending: Mutex::new(HashMap::new()),
        stream_id: AtomicU32::new(0),
    });
    let app = Router::new().fallback(handle).with_state(gate.clone());
    tokio::spawn(async move { axum::serve(listener, app).await });
    gate
}

fn json_reply(status: u16, body: serde_json::Value) -> Response {
    let status = StatusCode::from_u16(status).unwrap();
    (status, [(header::CONTENT_TYPE, "application/json")], body.to_string()).into_response()
}

async fn handle(State(gate): State<Arc<FakeGate>>, request: Request) -> Response {
    let path = request.uri().path().to_string();
    let bearer = format!("Bearer {}", gate.credential.lock());
    let authorized = request.headers().get(header::AUTHORIZATION).is_some_and(|v| v == &*bearer);
    match path.as_str() {
        "/__tunnel" => return accept_tunnel(gate, request, authorized).await,
        "/api/account/link/start" => {
            let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
            return json_reply(
                200,
                json!({
                    "deviceCode": "dev_1",
                    "userCode": "BEE-123",
                    "verificationUrl": format!("{}/link", gate.apex_url),
                    "expiresAt": now + 60_000,
                    "intervalMs": 5,
                }),
            );
        }
        "/api/account/link/poll" => {
            if gate.polls.fetch_add(1, Ordering::SeqCst) == 0 {
                return json_reply(200, json!({ "status": "pending" }));
            }
            let credential = gate.credential.lock().clone();
            return json_reply(
                200,
                json!({
                    "status": "approved", "credential": credential, "serverId": "srv_1",
                }),
            );
        }
        "/api/account/me" if authorized => {
            return json_reply(
                200,
                json!({
                    "serverId": "srv_1",
                    "serverLabel": "bee",
                    "serverUrl": format!("{}/", gate.gate_url),
                }),
            );
        }
        "/api/account/me" => return json_reply(401, json!({})),
        "/api/connect/machine-code" if authorized => {
            let n = gate.minted.fetch_add(1, Ordering::SeqCst) + 1;
            return json_reply(200, json!({ "code": format!("code_{n}") }));
        }
        "/api/connect/redeem-machine" => {
            let body = to_bytes(request.into_body(), 1 << 20).await.unwrap_or_default();
            let body: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
            let Some(n) = body["code"].as_str().and_then(|c| c.strip_prefix("code_")) else {
                return json_reply(400, json!({ "error": "invalid_code" }));
            };
            let (credential, machine_id) = (format!("bbcm_{n}"), format!("machine_{n}"));
            gate.machines.lock().insert(credential.clone(), machine_id.clone());
            return json_reply(200, json!({ "credential": credential, "machineId": machine_id }));
        }
        "/api/connect/revoke-machine" if authorized => {
            let body = to_bytes(request.into_body(), 1 << 20).await.unwrap_or_default();
            let body: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
            let machine_id = body["machineId"].as_str().unwrap_or_default().to_owned();
            gate.machines.lock().retain(|_, id| *id != machine_id);
            gate.revoked.lock().push(machine_id);
            return json_reply(200, json!({ "ok": true }));
        }
        "/api/connect/disconnect" if authorized => {
            gate.disconnects.fetch_add(1, Ordering::SeqCst);
            return json_reply(200, json!({ "ok": true }));
        }
        "/api/connect/machine-code" | "/api/connect/revoke-machine" | "/api/connect/disconnect" => {
            return json_reply(401, json!({}));
        }
        _ => {}
    }
    forward(gate, request).await
}

async fn accept_tunnel(gate: Arc<FakeGate>, request: Request, authorized: bool) -> Response {
    if !authorized {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if request.uri().query() != Some("v=1") {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let (mut parts, _) = request.into_parts();
    let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
        Ok(upgrade) => upgrade,
        Err(rejection) => return rejection.into_response(),
    };
    upgrade.on_upgrade(move |socket| run_tunnel(gate, socket))
}

async fn run_tunnel(gate: Arc<FakeGate>, mut socket: WebSocket) {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let id = gate.tunnels_accepted.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some((_, old)) = gate.tunnel.lock().replace((id, tx.clone())) {
        let reason = TUNNEL_REPLACED_CLOSE_REASON.into();
        let _ = old.send(Message::Close(Some(CloseFrame { code: 1000, reason })));
    }
    loop {
        tokio::select! {
            out = rx.recv() => {
                let Some(out) = out else { break };
                let close = matches!(out, Message::Close(_));
                if socket.send(out).await.is_err() || close {
                    break;
                }
            }
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Binary(data))) => {
                    if let Ok(frame) = decode_frame(&data) {
                        let target = gate.pending.lock().get(&frame.stream_id()).cloned();
                        if let Some(target) = target {
                            let _ = target.send(frame);
                        }
                    }
                }
                Some(Ok(Message::Text(text))) => {
                    if text.as_str() == HEARTBEAT_REQUEST && gate.ack_heartbeats.load(Ordering::SeqCst) {
                        let _ = tx.send(Message::Text(HEARTBEAT_RESPONSE.into()));
                    }
                }
                Some(Ok(_)) => {}
                _ => break,
            }
        }
    }
    let mut tunnel = gate.tunnel.lock();
    if tunnel.as_ref().is_some_and(|(current, _)| *current == id) {
        *tunnel = None;
    }
}

/// The headers the gate forwards: hop and gate-owned headers dropped, its admission added.
fn opening_headers(headers: &HeaderMap, admission: Admission) -> Vec<(String, String)> {
    let mut forwarded = Vec::new();
    for (name, value) in headers {
        let name = name.as_str();
        if is_hop(name) || GATE_HEADERS.contains(&name) {
            continue;
        }
        forwarded.push((name.to_string(), value.to_str().unwrap_or_default().to_string()));
    }
    if let Some(auth) = admission.auth {
        forwarded.push(("x-bb-gate-auth".to_string(), auth.to_string()));
    }
    if let Some(machine_id) = admission.machine_id {
        forwarded.push(("x-bb-gate-machine-id".to_string(), machine_id));
    }
    forwarded
}

fn is_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

async fn forward(gate: Arc<FakeGate>, request: Request) -> Response {
    let method = request.method().to_string();
    let path = request.uri().path().to_string();
    let admission = match gate.admit(&method, &path, request.headers()) {
        Ok(admission) => admission,
        Err(status) if is_upgrade(request.headers()) => {
            return StatusCode::from_u16(status).unwrap().into_response();
        }
        Err(status) => return json_reply(status, json!({})),
    };
    if gate.tunnel.lock().is_none() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if is_upgrade(request.headers()) {
        return open_visitor_socket(gate, request, admission).await;
    }
    let headers = opening_headers(request.headers(), admission);
    let stream_id = gate.stream_id.fetch_add(1, Ordering::SeqCst) + 1;
    let has_body = method != "GET" && method != "HEAD";
    let path_and_query = request.uri().path_and_query().map_or("/".to_string(), |p| p.to_string());
    let (tx, mut rx) = mpsc::unbounded_channel();
    gate.pending.lock().insert(stream_id, tx);
    gate.send(&Frame::OpenHttp(OpenHttpFrame {
        stream_id,
        method,
        path: path_and_query,
        headers,
        has_body,
        target: None,
    }));
    if has_body {
        let body = to_bytes(request.into_body(), usize::MAX).await.unwrap_or_default();
        for frame in chunk_body(stream_id, &body) {
            gate.send(&frame);
        }
        gate.send(&Frame::BodyEnd { stream_id });
    }
    let wait = Duration::from_secs(5);
    let head = loop {
        match tokio::time::timeout(wait, rx.recv()).await {
            Ok(Some(Frame::RespHead { status, headers, .. })) => break Some((status, headers)),
            Ok(Some(Frame::BodyEnd { .. } | Frame::CloseStream { .. })) | Ok(None) | Err(_) => {
                break None;
            }
            Ok(Some(_)) => {}
        }
    };
    let Some((status, headers)) = head else {
        gate.pending.lock().remove(&stream_id);
        return StatusCode::BAD_GATEWAY.into_response();
    };
    // The body streams as the frames arrive, as `response.write` does in fake-gate.ts: a
    // response without a length goes out chunked.
    let mut response = Response::builder().status(status);
    for (name, value) in headers.iter().filter(|(name, _)| !is_hop(name)) {
        response = response.header(name, value);
    }
    let pending = Arc::downgrade(&gate);
    let body = futures::stream::unfold(Some(rx), move |rx| {
        let pending = pending.clone();
        async move {
            let mut rx = rx?;
            loop {
                let frame = tokio::time::timeout(wait, rx.recv()).await.ok().flatten();
                match frame {
                    Some(Frame::BodyChunk { data, .. }) => {
                        return Some((Ok::<_, std::io::Error>(bytes::Bytes::from(data)), Some(rx)));
                    }
                    Some(Frame::BodyEnd { .. } | Frame::CloseStream { .. }) | None => {
                        if let Some(gate) = pending.upgrade() {
                            gate.pending.lock().remove(&stream_id);
                        }
                        return None;
                    }
                    Some(_) => {}
                }
            }
        }
    });
    response.body(Body::from_stream(body)).unwrap()
}

/// A visitor's WebSocket, relayed over the tunnel as `open-ws`, `ws-data` and `close-stream`.
async fn open_visitor_socket(
    gate: Arc<FakeGate>,
    request: Request,
    admission: Admission,
) -> Response {
    let offered = request
        .headers()
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let protocols: Vec<String> =
        offered.split(',').map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned).collect();
    let path = request.uri().path_and_query().map_or("/".to_string(), |p| p.to_string());
    let headers = opening_headers(request.headers(), admission);
    let (mut parts, _) = request.into_parts();
    let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
        Ok(upgrade) => upgrade,
        Err(rejection) => return rejection.into_response(),
    };
    let stream_id = gate.stream_id.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = mpsc::unbounded_channel();
    gate.pending.lock().insert(stream_id, tx);
    gate.send(&Frame::OpenWs(OpenWsFrame {
        stream_id,
        path,
        headers,
        protocols: protocols.clone(),
        target: None,
    }));
    upgrade
        .protocols(protocols)
        .on_upgrade(move |socket| relay_visitor(gate, stream_id, socket, rx))
}

async fn relay_visitor(
    gate: Arc<FakeGate>,
    stream_id: u32,
    mut socket: WebSocket,
    mut rx: mpsc::UnboundedReceiver<Frame>,
) {
    loop {
        tokio::select! {
            frame = rx.recv() => match frame {
                Some(Frame::WsData { is_binary, data, .. }) => {
                    let message = if is_binary {
                        Message::Binary(data.into())
                    } else {
                        Message::Text(String::from_utf8_lossy(&data).into_owned().into())
                    };
                    if socket.send(message).await.is_err() {
                        break;
                    }
                }
                Some(Frame::CloseStream { code, reason, .. }) => {
                    let frame = CloseFrame { code, reason: reason.into() };
                    let _ = socket.send(Message::Close(Some(frame))).await;
                    break;
                }
                Some(_) => {}
                None => break,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => gate.send(&Frame::WsData {
                    stream_id,
                    is_binary: false,
                    data: text.as_str().as_bytes().to_vec(),
                }),
                Some(Ok(Message::Binary(data))) => {
                    gate.send(&Frame::WsData { stream_id, is_binary: true, data: data.to_vec() });
                }
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) =
                        frame.map_or((1000, String::new()), |f| (f.code, f.reason.to_string()));
                    let code = if code == 1000 || code >= 3000 { code } else { 1000 };
                    gate.send(&Frame::CloseStream { stream_id, code, reason });
                    break;
                }
                Some(Ok(_)) => {}
                _ => {
                    gate.send(&Frame::CloseStream { stream_id, code: 1000, reason: String::new() });
                    break;
                }
            }
        }
    }
    gate.pending.lock().remove(&stream_id);
}
