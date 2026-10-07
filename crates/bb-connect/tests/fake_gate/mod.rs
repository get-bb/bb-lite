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
use bb_tunnel::{Frame, OpenHttpFrame, chunk_body, decode_frame, encode_frame};
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

async fn forward(gate: Arc<FakeGate>, request: Request) -> Response {
    let method = request.method().to_string();
    let path = request.uri().path().to_string();
    let admission = match gate.admit(&method, &path, request.headers()) {
        Ok(admission) => admission,
        Err(status) => return json_reply(status, json!({})),
    };
    if gate.tunnel.lock().is_none() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let mut headers = Vec::new();
    for (name, value) in request.headers() {
        let name = name.as_str();
        if is_hop(name) || GATE_HEADERS.contains(&name) {
            continue;
        }
        headers.push((name.to_string(), value.to_str().unwrap_or_default().to_string()));
    }
    if let Some(auth) = admission.auth {
        headers.push(("x-bb-gate-auth".to_string(), auth.to_string()));
    }
    if let Some(machine_id) = admission.machine_id {
        headers.push(("x-bb-gate-machine-id".to_string(), machine_id));
    }
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
    let mut head = None;
    let mut body = Vec::new();
    let wait = Duration::from_secs(5);
    while let Ok(Some(frame)) = tokio::time::timeout(wait, rx.recv()).await {
        match frame {
            Frame::RespHead { status, headers, .. } => head = Some((status, headers)),
            Frame::BodyChunk { data, .. } => body.extend(data),
            Frame::BodyEnd { .. } | Frame::CloseStream { .. } => break,
            _ => {}
        }
    }
    gate.pending.lock().remove(&stream_id);
    let Some((status, headers)) = head else { return StatusCode::BAD_GATEWAY.into_response() };
    let mut response = Response::builder().status(status);
    for (name, value) in headers.iter().filter(|(name, _)| !is_hop(name)) {
        if name != "content-length" {
            response = response.header(name, value);
        }
    }
    response.body(Body::from(body)).unwrap()
}
