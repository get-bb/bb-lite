use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, anyhow, bail};
use base64::Engine;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use bb_core::{RunnerEventSink, SharedRunner};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::cli_proxy::{CliProxyOptions, start_cli_proxy};
use crate::outbox::Outbox;
use crate::protocol::REPLACED_CLOSE_CODE;
use crate::serve::{RunnerServing, serve_runner};
use crate::socket::WireSocket;

const CREDENTIALS_FILE: &str = "runner.json";
const CONNECT_MACHINE_HEADER: &str = "x-bb-connect-machine";
const CONNECT_TIMEOUT_MS: u64 = 10_000;
const MIN_RETRY_MS: u64 = 1_000;
const MAX_RETRY_MS: u64 = 10_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JoinBlob {
    server_url: String,
    host_id: String,
    join_token: String,
    #[serde(default)]
    headers: Option<Map<String, Value>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JoinReply {
    host_id: String,
    runner_token: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub host_id: String,
    pub runner_token: String,
    pub server_url: String,
    pub headers: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyMachineConfig {
    server_headers: Option<Map<String, Value>>,
    machine_credential: Option<String>,
}

#[derive(Default)]
pub struct JoinOptions {
    pub blob: String,
    pub data_dir: Option<PathBuf>,
    pub host_name: Option<String>,
    pub headers: Vec<String>,
    pub legacy_machine_config_path: Option<PathBuf>,
}

/// What the daemon's local-runner factory receives: the CLI proxy URL to hand
/// agents as the server URL, and the sink every runner event must go to.
pub struct LocalSetup {
    pub data_dir: PathBuf,
    pub server_url: String,
    pub sink: RunnerEventSink,
}

pub struct LocalParts {
    pub runner: SharedRunner,
    pub outbox: Arc<Outbox>,
    pub shutdown: Box<dyn FnOnce() -> BoxFuture<'static, ()> + Send>,
}

pub type LocalFactory = Box<dyn FnOnce(LocalSetup) -> LocalParts + Send>;
pub type Log = Arc<dyn Fn(&str) + Send + Sync>;

pub struct RunOptions {
    pub data_dir: PathBuf,
    pub make_local: LocalFactory,
    pub log: Option<Log>,
}

pub struct RunningRunner {
    pub cli_proxy_url: String,
    stop: CancellationToken,
    stopped: watch::Receiver<bool>,
}

impl RunningRunner {
    pub async fn stopped(&self) {
        let mut stopped = self.stopped.clone();
        let _ = stopped.wait_for(|stopped| *stopped).await;
    }

    pub async fn stop(&self) {
        self.stop.cancel();
        self.stopped().await;
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

fn url_host(server_url: &str) -> anyhow::Result<String> {
    let url = Url::parse(server_url)?;
    let host = url.host_str().ok_or_else(|| anyhow!("{server_url} has no host"))?;
    Ok(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}

pub fn default_runner_data_dir(server_url: &str) -> anyhow::Result<PathBuf> {
    Ok(home_dir().join(".bb-150k-runner").join(url_host(server_url)?))
}

pub fn default_legacy_machine_config_path(server_url: &str) -> anyhow::Result<PathBuf> {
    Ok(home_dir().join(".bb-machines").join(url_host(server_url)?).join("config.json"))
}

fn parse_header_pair(pair: &str) -> anyhow::Result<(String, String)> {
    let valid = |name: &str| {
        !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    };
    match pair.split_once('=') {
        Some((name, value))
            if valid(name) && !value.is_empty() && !value.contains(['\n', '\r']) =>
        {
            Ok((name.to_lowercase(), value.to_owned()))
        }
        _ => bail!("Expected a header as name=value, got \"{pair}\""),
    }
}

async fn read_legacy_headers(path: &Path) -> anyhow::Result<Map<String, Value>> {
    let config: LegacyMachineConfig =
        serde_json::from_str(&tokio::fs::read_to_string(path).await?)?;
    if let Some(headers) = config.server_headers {
        return Ok(headers);
    }
    let Some(credential) = config.machine_credential.filter(|value| !value.is_empty()) else {
        bail!("{} holds no bb connect machine credential", path.display());
    };
    Ok(Map::from_iter([(CONNECT_MACHINE_HEADER.to_owned(), Value::String(credential))]))
}

fn host_name() -> String {
    let mut buffer = [0u8; 256];
    let result = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
    if result != 0 {
        return String::new();
    }
    let end = buffer.iter().position(|byte| *byte == 0).unwrap_or(buffer.len());
    String::from_utf8_lossy(&buffer[..end]).into_owned()
}

fn header_map(headers: &Map<String, Value>) -> reqwest::header::HeaderMap {
    let mut map = reqwest::header::HeaderMap::new();
    for (name, value) in headers {
        if let (Ok(name), Some(Ok(value))) = (
            reqwest::header::HeaderName::try_from(name.as_str()),
            value.as_str().map(HeaderValue::from_str),
        ) {
            map.insert(name, value);
        }
    }
    map
}

pub async fn join_server(options: JoinOptions) -> anyhow::Result<(Credentials, PathBuf)> {
    let engine = GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    let decoded = engine.decode(options.blob.trim()).context("The join blob is not base64url")?;
    let blob: JoinBlob = serde_json::from_slice(&decoded)?;
    Url::parse(&blob.server_url)?;
    if blob.host_id.is_empty() || blob.join_token.is_empty() {
        bail!("The join blob is missing its host id or join token");
    }
    let server_url = blob.server_url.trim_end_matches('/').to_owned();
    let mut headers = blob.headers.unwrap_or_default();
    if let Some(path) = &options.legacy_machine_config_path {
        headers.extend(read_legacy_headers(path).await?);
    }
    for pair in &options.headers {
        let (name, value) = parse_header_pair(pair)?;
        headers.insert(name, Value::String(value));
    }
    let data_dir = match options.data_dir {
        Some(dir) => dir,
        None => default_runner_data_dir(&server_url)?,
    };
    tokio::fs::create_dir_all(&data_dir).await?;
    let host_name = options.host_name.unwrap_or_else(host_name);
    let response = reqwest::Client::new()
        .post(format!("{server_url}/internal/runner/join"))
        .headers(header_map(&headers))
        .bearer_auth(&blob.join_token)
        .json(&json!({ "hostName": host_name }))
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        bail!("The server refused to join: {} {detail}", status.as_u16());
    }
    let reply: JoinReply = response.json().await?;
    if reply.host_id.is_empty() || reply.runner_token.is_empty() {
        bail!("The server's join reply is missing its host id or runner token");
    }
    let credentials = Credentials {
        host_id: reply.host_id,
        runner_token: reply.runner_token,
        server_url,
        headers,
    };
    let file = data_dir.join(CREDENTIALS_FILE);
    let content = format!("{}\n", serde_json::to_string_pretty(&credentials)?);
    tokio::fs::write(&file, content).await?;
    tokio::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).await?;
    Ok((credentials, data_dir))
}

async fn dial(
    target: &str,
    headers: &Map<String, Value>,
    token: &str,
) -> anyhow::Result<WireSocket> {
    let mut request = target.into_client_request()?;
    let fields = request.headers_mut();
    fields.extend(header_map(headers));
    fields.insert("authorization", HeaderValue::from_str(&format!("Bearer {token}"))?);
    let connect = tokio_tungstenite::connect_async(request);
    let timeout = Duration::from_millis(CONNECT_TIMEOUT_MS);
    let (stream, _) = tokio::time::timeout(timeout, connect)
        .await
        .map_err(|_| anyhow!("Opening handshake has timed out"))??;
    Ok(WireSocket::from_tungstenite(stream))
}

async fn signalled() {
    use tokio::signal::unix::{SignalKind, signal};
    match (signal(SignalKind::interrupt()), signal(SignalKind::terminate())) {
        (Ok(mut interrupt), Ok(mut terminate)) => {
            tokio::select! {
                _ = interrupt.recv() => {}
                _ = terminate.recv() => {}
            }
        }
        _ => std::future::pending().await,
    }
}

pub async fn run_runner(options: RunOptions) -> anyhow::Result<RunningRunner> {
    let log: Log = options.log.unwrap_or_else(|| Arc::new(|message: &str| eprintln!("{message}")));
    let file = options.data_dir.join(CREDENTIALS_FILE);
    let stored: Credentials = serde_json::from_str(&tokio::fs::read_to_string(&file).await?)?;
    Url::parse(&stored.server_url)?;
    let proxy = start_cli_proxy(CliProxyOptions {
        server_url: stored.server_url.clone(),
        headers: stored.headers.clone(),
        runner_token: stored.runner_token.clone(),
    })
    .await?;
    let target = format!("{}/internal/runner/ws", stored.server_url.replacen("http", "ws", 1));
    let serving: Arc<Mutex<Option<RunnerServing>>> = Arc::default();
    let delivering = serving.clone();
    let sink: RunnerEventSink = Arc::new(move |event| {
        let current = delivering.lock().clone();
        if let Some(serving) = current {
            serving.deliver(event);
        }
    });
    let local = (options.make_local)(LocalSetup {
        data_dir: options.data_dir.clone(),
        server_url: proxy.url.clone(),
        sink,
    });
    let stop = CancellationToken::new();
    let (stopped_tx, stopped) = watch::channel(false);
    let cli_proxy_url = proxy.url.clone();
    let stopping = stop.clone();
    tokio::spawn(async move {
        tokio::select! {
            _ = signalled() => stopping.cancel(),
            _ = stopping.cancelled() => {}
        }
    });
    let stopping = stop.clone();
    tokio::spawn(async move {
        let mut retry_ms = MIN_RETRY_MS;
        loop {
            let code = tokio::select! {
                _ = stopping.cancelled() => break,
                socket = dial(&target, &stored.headers, &stored.runner_token) => match socket {
                    Ok(socket) => {
                        retry_ms = MIN_RETRY_MS;
                        let (runner, outbox) = (local.runner.clone(), local.outbox.clone());
                        let current = serve_runner(runner, outbox, socket);
                        let link = current.link().clone();
                        *serving.lock() = Some(current);
                        let code = tokio::select! {
                            _ = stopping.cancelled() => {
                                link.terminate();
                                None
                            }
                            code = link.closed() => code,
                        };
                        *serving.lock() = None;
                        code
                    }
                    Err(error) => {
                        log(&format!("bb runner: connection error: {error}"));
                        None
                    }
                },
            };
            if stopping.is_cancelled() {
                break;
            }
            if code == Some(REPLACED_CLOSE_CODE) {
                log("bb runner: this machine was replaced or removed; stopping");
                break;
            }
            let shown = code.unwrap_or(1006);
            log(&format!("bb runner: disconnected ({shown}); retrying in {retry_ms} ms"));
            tokio::select! {
                _ = stopping.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_millis(retry_ms)) => {}
            }
            retry_ms = (retry_ms * 2).min(MAX_RETRY_MS);
        }
        stopping.cancel();
        (local.shutdown)().await;
        proxy.close().await;
        let _ = stopped_tx.send(true);
    });
    Ok(RunningRunner { cli_proxy_url, stop, stopped })
}
