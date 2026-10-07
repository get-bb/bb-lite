mod fake_gate;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::Request;
use bb_connect::{
    AccountOptions, ConnectAccount, ConnectState, ConnectTunnel, LoginState, TunnelOptions,
};
use bb_tunnel::{Heartbeat, TunnelLog};
use fake_gate::{FakeGate, start_fake_gate};
use serde_json::{Value, json};
use tokio::time::sleep;

const OWNER: (&str, &str) = ("cookie", "session=owner");

struct Quiet;

impl TunnelLog for Quiet {
    fn warn(&self, _message: &str) {}
}

async fn wait_for(what: &str, mut check: impl FnMut() -> bool) {
    for _ in 0..500 {
        if check() {
            return;
        }
        sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn start_echo_origin() -> String {
    let echo = |request: Request| async move {
        let method = request.method().to_string();
        let url = request.uri().path_and_query().map(|p| p.to_string());
        let headers: serde_json::Map<String, Value> = request
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), json!(v.to_str().unwrap_or_default())))
            .collect();
        let body = to_bytes(request.into_body(), usize::MAX).await.unwrap_or_default();
        let body = String::from_utf8_lossy(&body).to_string();
        Body::from(
            json!({ "method": method, "url": url, "headers": headers, "body": body }).to_string(),
        )
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, Router::new().fallback(echo)).await });
    format!("http://127.0.0.1:{port}")
}

struct Client {
    gate: Arc<FakeGate>,
    account: ConnectAccount,
    tunnel: ConnectTunnel,
    loopback_url: String,
    file: PathBuf,
    _dir: tempfile::TempDir,
}

impl Client {
    async fn connected(&self) {
        wait_for("connected", || self.tunnel.status().state == ConnectState::Connected).await;
    }
}

async fn start_client(heartbeat: Option<Heartbeat>) -> Client {
    let gate = start_fake_gate().await;
    let loopback_url = start_echo_origin().await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("connect.json");
    let tunnel_slot: Arc<parking_lot::Mutex<Option<(ConnectTunnel, ConnectAccount)>>> =
        Arc::default();
    let slot = tunnel_slot.clone();
    let on_change = Arc::new(move || {
        let pair = slot.lock().clone();
        if let Some((tunnel, account)) = pair {
            tunnel.set(account.link());
        }
    });
    let mut options = AccountOptions::new(
        file.clone(),
        gate.apex_url.clone(),
        "test".to_string(),
        Arc::new(|_| {}),
        on_change,
    );
    options.poll_margin = Duration::from_millis(1);
    let account = ConnectAccount::new(options);
    let refusing = account.clone();
    let mut options = TunnelOptions::new(
        loopback_url.clone(),
        Arc::new(|_| false),
        Arc::new(move |credential| {
            let account = refusing.clone();
            Box::pin(async move { account.confirm_refused(&credential).await })
        }),
        Arc::new(Quiet),
        Arc::new(|| {}),
    );
    options.retry_base = Duration::from_millis(4);
    options.retry_max = Duration::from_millis(8);
    options.replaced_hold = Duration::from_millis(400);
    options.heartbeat = heartbeat;
    let tunnel = ConnectTunnel::new(options);
    *tunnel_slot.lock() = Some((tunnel.clone(), account.clone()));
    Client { gate, account, tunnel, loopback_url, file, _dir: dir }
}

async fn visit(
    gate: &FakeGate,
    path: &str,
    method: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> (u16, String) {
    let client = reqwest::Client::new();
    let method = reqwest::Method::from_bytes(method.as_bytes()).unwrap();
    let mut request = client.request(method, format!("{}{path}", gate.gate_url));
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    if !body.is_empty() {
        request = request.body(body.to_string());
    }
    let response = request.send().await.unwrap();
    (response.status().as_u16(), response.text().await.unwrap())
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

#[tokio::test]
async fn marks_forwarded_requests_and_drops_a_visitors_own_marker() {
    let client = start_client(None).await;
    client.account.adopt(Some(client.gate.link())).unwrap();
    client.connected().await;
    let gate_url = client.gate.gate_url.clone();
    let headers = [
        OWNER,
        ("X-BB-Via-Tunnel", "0"),
        ("x-bb-gate-auth", "machine"),
        ("origin", gate_url.as_str()),
    ];
    let (status, text) = visit(&client.gate, "/echo?x=1", "POST", &headers, "hello").await;
    assert_eq!(status, 200);
    let seen: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(seen["method"], "POST");
    assert_eq!(seen["url"], "/echo?x=1");
    assert_eq!(seen["body"], "hello");
    let loopback = url::Url::parse(&client.loopback_url).unwrap();
    let host = format!("127.0.0.1:{}", loopback.port().unwrap());
    let seen = &seen["headers"];
    assert_eq!(seen["x-bb-via-tunnel"], "1");
    assert_eq!(seen["x-bb-gate-auth"], "session");
    assert_eq!(seen["origin"], client.loopback_url.as_str());
    assert_eq!(seen["host"], host.as_str());
    assert_eq!(seen["cookie"], "session=owner");
    assert_eq!(visit(&client.gate, "/echo", "GET", &[], "").await.0, 401);
    client.tunnel.set(None);
}

#[tokio::test]
async fn redials_after_a_lost_keepalive_and_holds_off_when_replaced() {
    let heartbeat =
        Heartbeat { interval: Duration::from_millis(10), deadline: Duration::from_millis(40) };
    let client = start_client(Some(heartbeat)).await;
    let gate = client.gate.clone();
    client.account.adopt(Some(gate.link())).unwrap();
    client.connected().await;
    gate.ack_heartbeats.store(false, Ordering::SeqCst);
    wait_for("a redial", || gate.tunnels() > 1).await;
    gate.ack_heartbeats.store(true, Ordering::SeqCst);
    sleep(Duration::from_millis(100)).await;
    client.connected().await;

    let dial_url = format!("{}/__tunnel?v=1", gate.gate_url.replace("http", "ws"));
    let mut request =
        tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(dial_url)
            .unwrap();
    let bearer = format!("Bearer {}", gate.credential.lock());
    request.headers_mut().insert("authorization", bearer.parse().unwrap());
    let (_intruder, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let took_over = || client.tunnel.status().last_error.is_some_and(|e| e.contains("took over"));
    wait_for("the replaced error", took_over).await;
    let status = client.tunnel.status();
    assert_eq!(status.state, ConnectState::Reconnecting);
    assert!(status.next_retry_at.unwrap() > now_ms() + 200);
    let held = gate.tunnels();
    sleep(Duration::from_millis(100)).await;
    assert_eq!(gate.tunnels(), held);
    wait_for("the held redial", || gate.tunnels() == held + 1).await;
    client.tunnel.set(None);
}

#[tokio::test]
async fn signs_out_when_the_gate_refuses_a_revoked_credential() {
    let client = start_client(None).await;
    let mut link = client.gate.link();
    link.credential = "bbcred_revoked".to_string();
    client.account.adopt(Some(link)).unwrap();
    wait_for("sign-out", || client.account.link().is_none()).await;
    assert!(!client.file.exists());
    assert_eq!(client.tunnel.status().state, ConnectState::Disconnected);
}

#[tokio::test]
async fn device_login_adopts_the_approved_link() {
    let client = start_client(None).await;
    let login = client.account.start_login().await.unwrap();
    assert_eq!(login.state, LoginState::Pending);
    assert_eq!(login.user_code, "BEE-123");
    let again = client.account.start_login().await.unwrap();
    assert_eq!(again, login);
    wait_for("the link", || client.account.link().is_some()).await;
    let link = client.account.link().unwrap();
    assert_eq!(link, client.gate.link());
    assert_eq!(client.account.login().unwrap().state, LoginState::SignedIn);
    assert!(client.gate.polls.load(Ordering::SeqCst) >= 2);
    client.connected().await;
    client.tunnel.set(None);
}

#[tokio::test]
async fn a_tls_dial_reports_an_error_instead_of_panicking() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gate_url = format!("https://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            drop(socket);
        }
    });
    let mut options = TunnelOptions::new(
        "http://127.0.0.1:9".to_string(),
        Arc::new(|_| false),
        Arc::new(|_| Box::pin(async { Ok(()) })),
        Arc::new(Quiet),
        Arc::new(|| {}),
    );
    options.retry_base = Duration::from_millis(4);
    options.retry_max = Duration::from_millis(8);
    let tunnel = ConnectTunnel::new(options);
    tunnel.set(Some(bb_connect::account::Link {
        base_url: gate_url.clone(),
        server_url: gate_url,
        server_id: "srv_1".to_string(),
        server_label: "test".to_string(),
        credential: "bbc_test".to_string(),
    }));
    wait_for("a dial error", || tunnel.status().last_error.is_some()).await;
    assert_ne!(tunnel.status().state, ConnectState::Connected);
    tunnel.set(None);
}
