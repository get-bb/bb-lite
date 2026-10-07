use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use bb_tunnel::contract::{
    PROTOCOL_VERSION, TUNNEL_PROTOCOL_QUERY_PARAM, TUNNEL_REPLACED_CLOSE_REASON,
};
use bb_tunnel::{
    Heartbeat, ResolvedStreamOrigin, StreamOriginResult, TunnelLog, TunnelMessage, TunnelSession,
    TunnelSessionOptions, TunnelSocket,
};
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::task::JoinHandle;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use url::Url;

use crate::account::{Link, now_ms, share_url};
use crate::contract::ConnectState;
use crate::hosted::{ConnectError, host_of};

const CLEAN_CLOSE_CODE: u16 = 1000;
const ABNORMAL_CLOSE_CODE: u16 = 1006;
const STABLE: Duration = Duration::from_millis(10_000);
const TAKEN: &str = "another bb took over this server's bb connect tunnel";

pub type ConfirmRefused = Arc<
    dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<(), ConnectError>> + Send>> + Send + Sync,
>;

pub struct TunnelOptions {
    pub loopback_url: String,
    pub is_shared: Arc<dyn Fn(u16) -> bool + Send + Sync>,
    pub confirm_refused: ConfirmRefused,
    pub log: Arc<dyn TunnelLog>,
    pub on_change: Arc<dyn Fn() + Send + Sync>,
    pub handshake: Duration,
    pub replaced_hold: Duration,
    pub retry_base: Duration,
    pub retry_max: Duration,
    pub heartbeat: Option<Heartbeat>,
}

impl TunnelOptions {
    /// Options with the default handshake timeout (10s), replaced hold (5min), retry backoff
    /// (1s doubling to 30s) and the session's default heartbeat.
    pub fn new(
        loopback_url: String,
        is_shared: Arc<dyn Fn(u16) -> bool + Send + Sync>,
        confirm_refused: ConfirmRefused,
        log: Arc<dyn TunnelLog>,
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        TunnelOptions {
            loopback_url,
            is_shared,
            confirm_refused,
            log,
            on_change,
            handshake: Duration::from_millis(10_000),
            replaced_hold: Duration::from_millis(5 * 60_000),
            retry_base: Duration::from_millis(1_000),
            retry_max: Duration::from_millis(30_000),
            heartbeat: None,
        }
    }
}

/// The tunnel's part of [`crate::ConnectStatus`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub state: ConnectState,
    pub last_error: Option<String>,
    pub next_retry_at: Option<u64>,
}

#[derive(Default)]
struct State {
    link: Option<Link>,
    task: Option<JoinHandle<()>>,
    session: Option<Arc<TunnelSession>>,
    closing: Option<Arc<AtomicBool>>,
    dial_id: u64,
    connected: bool,
    last_error: Option<String>,
    next_retry_at: Option<u64>,
    attempt: u32,
}

struct Inner {
    options: TunnelOptions,
    state: Mutex<State>,
}

/// Keeps one tunnel to the gate of the current link open, redialling with backoff.
#[derive(Clone)]
pub struct ConnectTunnel {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Closed {
    frame: Option<(u16, String)>,
    error: Option<String>,
}

struct GateSocket<S> {
    ws: WebSocketStream<S>,
    closing: Arc<AtomicBool>,
    closed: Arc<Mutex<Closed>>,
}

#[async_trait]
impl<S> TunnelSocket for GateSocket<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    async fn send_binary(&mut self, data: Vec<u8>) -> std::io::Result<()> {
        self.ws.send(Message::Binary(data.into())).await.map_err(std::io::Error::other)
    }

    async fn send_text(&mut self, text: String) -> std::io::Result<()> {
        self.ws.send(Message::Text(text.into())).await.map_err(std::io::Error::other)
    }

    async fn recv(&mut self) -> Option<TunnelMessage> {
        loop {
            match self.ws.next().await? {
                Ok(Message::Binary(data)) => return Some(TunnelMessage::Binary(data.to_vec())),
                Ok(Message::Text(text)) => return Some(TunnelMessage::Text(text.to_string())),
                Ok(Message::Close(frame)) => {
                    let (code, reason) = frame.map_or((1005, String::new()), |f| {
                        (u16::from(f.code), f.reason.to_string())
                    });
                    self.closed.lock().frame = Some((code, reason));
                    return None;
                }
                Err(error) => {
                    self.closed.lock().error = Some(error.to_string());
                    return None;
                }
                Ok(_) => {}
            }
        }
    }

    async fn close(&mut self) {
        if self.closing.load(Ordering::SeqCst) {
            let frame = CloseFrame {
                code: CloseCode::from(CLEAN_CLOSE_CODE),
                reason: "tunnel closed by bb".into(),
            };
            let _ = tokio::time::timeout(Duration::from_secs(1), self.ws.close(Some(frame))).await;
        }
    }
}

impl ConnectTunnel {
    pub fn new(options: TunnelOptions) -> Self {
        ConnectTunnel { inner: Arc::new(Inner { options, state: Mutex::new(State::default()) }) }
    }

    /// Points the tunnel at `link` (or closes it for `None`); a no-op when the server URL and
    /// credential are unchanged. Must run inside a tokio runtime.
    pub fn set(&self, link: Option<Link>) {
        {
            let mut state = self.inner.state.lock();
            let key =
                |l: &Option<Link>| l.as_ref().map(|l| (l.server_url.clone(), l.credential.clone()));
            if key(&link) == key(&state.link) {
                return;
            }
            state.dial_id += 1;
            if let Some(task) = state.task.take() {
                task.abort();
            }
            if let Some(closing) = state.closing.take() {
                closing.store(true, Ordering::SeqCst);
            }
            if let Some(session) = state.session.take() {
                session.dispose();
            }
            state.connected = false;
            state.last_error = None;
            state.next_retry_at = None;
            state.attempt = 0;
            state.link = link;
        }
        self.dial();
    }

    pub fn status(&self) -> TunnelStatus {
        let state = self.inner.state.lock();
        let live =
            if state.connected { ConnectState::Connected } else { ConnectState::Reconnecting };
        TunnelStatus {
            state: if state.link.is_none() { ConnectState::Disconnected } else { live },
            last_error: state.last_error.clone(),
            next_retry_at: state.next_retry_at,
        }
    }

    fn resolve_origin(&self, link: &Link, target: Option<&str>) -> StreamOriginResult {
        let Some(target) = target else {
            let public_origin =
                Url::parse(&link.server_url).map(|u| u.origin().ascii_serialization());
            return StreamOriginResult::Ok(ResolvedStreamOrigin {
                origin: self.inner.options.loopback_url.clone(),
                public_origin: public_origin.unwrap_or_default(),
                host: None,
            });
        };
        let digits =
            !target.is_empty() && target.len() <= 5 && target.bytes().all(|b| b.is_ascii_digit());
        let port = target.parse::<u16>().ok().filter(|_| digits);
        let Some(port) = port.filter(|port| (self.inner.options.is_shared)(*port)) else {
            return StreamOriginResult::Unregistered;
        };
        let host = format!("127.0.0.1:{port}");
        StreamOriginResult::Ok(ResolvedStreamOrigin {
            origin: format!("http://{host}"),
            public_origin: share_url(link, port),
            host: Some(host),
        })
    }

    fn dial(&self) {
        let mut state = self.inner.state.lock();
        let Some(link) = state.link.clone() else { return };
        state.dial_id += 1;
        let dial_id = state.dial_id;
        let tunnel = self.clone();
        state.task = Some(tokio::spawn(async move { tunnel.run(link, dial_id).await }));
    }

    async fn run(&self, link: Link, dial_id: u64) {
        let options = &self.inner.options;
        let ws_base = match link.server_url.strip_prefix("http") {
            Some(rest) => format!("ws{rest}"),
            None => link.server_url.clone(),
        };
        let mut url = match Url::parse(&format!("{ws_base}/__tunnel")) {
            Ok(url) => url,
            Err(error) => return self.fail(dial_id, None, format!("Invalid URL: {error}"), None),
        };
        url.query_pairs_mut()
            .append_pair(TUNNEL_PROTOCOL_QUERY_PARAM, &PROTOCOL_VERSION.to_string());
        let host = host_of(&url);
        let mut request = match url.as_str().into_client_request() {
            Ok(request) => request,
            Err(error) => {
                return self.fail(dial_id, None, format!("can't reach {host}: {error}"), None);
            }
        };
        let bearer = format!("Bearer {}", link.credential);
        match bearer.parse() {
            Ok(value) => {
                request.headers_mut().insert("authorization", value);
            }
            Err(error) => {
                return self.fail(dial_id, None, format!("can't reach {host}: {error}"), None);
            }
        }
        bb_tunnel::tls::install_crypto_provider();
        let connected =
            tokio::time::timeout(options.handshake, tokio_tungstenite::connect_async(request))
                .await;
        let ws = match connected {
            Err(_) => {
                let reason = format!("can't reach {host}: the handshake timed out");
                return self.fail(dial_id, None, reason, None);
            }
            Ok(Err(WsError::Http(response))) => {
                let status = response.status().as_u16();
                if (status == 401 || status == 403) && self.current(dial_id) {
                    let confirming = (options.confirm_refused)(link.credential.clone());
                    let log = options.log.clone();
                    tokio::spawn(async move {
                        if let Err(error) = confirming.await {
                            log.warn(&format!("could not check the refused credential: {error}"));
                        }
                    });
                }
                let reason = format!("the bb connect gate refused the tunnel (HTTP {status})");
                return self.fail(dial_id, None, reason, None);
            }
            Ok(Err(error)) => {
                return self.fail(dial_id, None, format!("can't reach {host}: {error}"), None);
            }
            Ok(Ok((ws, _))) => ws,
        };
        let closing = Arc::new(AtomicBool::new(false));
        let closed = Arc::new(Mutex::new(Closed::default()));
        let socket = GateSocket { ws, closing: closing.clone(), closed: closed.clone() };
        let opened_at = Instant::now();
        let session = {
            let mut state = self.inner.state.lock();
            if state.dial_id != dial_id {
                return;
            }
            state.connected = true;
            state.last_error = None;
            let tunnel = self.clone();
            let resolve_link = link.clone();
            let session = Arc::new(TunnelSession::start(
                socket,
                TunnelSessionOptions {
                    log: options.log.clone(),
                    resolve_origin: Arc::new(move |target| {
                        tunnel.resolve_origin(&resolve_link, target)
                    }),
                    heartbeat: options.heartbeat,
                },
            ));
            state.session = Some(session.clone());
            state.closing = Some(closing);
            session
        };
        options.log.info(&format!("tunnel connected to {host}"));
        (options.on_change)();
        session.closed().await;
        let closed = std::mem::take(&mut *closed.lock());
        let (code, reason) = closed.frame.unwrap_or((ABNORMAL_CLOSE_CODE, String::new()));
        if code == CLEAN_CLOSE_CODE && reason == TUNNEL_REPLACED_CLOSE_REASON {
            return self.fail(
                dial_id,
                Some(opened_at),
                TAKEN.to_string(),
                Some(options.replaced_hold),
            );
        }
        let transport = closed.error.map(|error| format!("can't reach {host}: {error}"));
        let reason = transport.unwrap_or_else(|| format!("tunnel closed (code {code})"));
        self.fail(dial_id, Some(opened_at), reason, None);
    }

    fn current(&self, dial_id: u64) -> bool {
        self.inner.state.lock().dial_id == dial_id
    }

    fn fail(
        &self,
        dial_id: u64,
        opened_at: Option<Instant>,
        reason: String,
        hold: Option<Duration>,
    ) {
        let options = &self.inner.options;
        let delay = {
            let mut state = self.inner.state.lock();
            if state.dial_id != dial_id {
                return;
            }
            state.dial_id += 1;
            state.closing = None;
            if let Some(session) = state.session.take() {
                session.dispose();
            }
            let stable = opened_at.is_some_and(|at| at.elapsed() > STABLE);
            state.attempt = if stable { 0 } else { state.attempt.saturating_add(1) };
            let doubled = options.retry_base.as_millis() as f64 * 2f64.powi(state.attempt as i32);
            let ceiling = doubled.min(options.retry_max.as_millis() as f64);
            let jitter = 0.5 + rand::random::<f64>() / 2.0;
            let backoff = Duration::from_millis((ceiling * jitter).round() as u64);
            let delay = hold.unwrap_or(backoff);
            state.connected = false;
            state.last_error = Some(reason.clone());
            state.next_retry_at = Some(now_ms() + delay.as_millis() as u64);
            let tunnel = self.clone();
            state.task = Some(tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                tunnel.inner.state.lock().next_retry_at = None;
                tunnel.dial();
            }));
            delay
        };
        options.log.warn(&format!("{reason}; reconnecting in {}ms", delay.as_millis()));
        (options.on_change)();
    }
}
