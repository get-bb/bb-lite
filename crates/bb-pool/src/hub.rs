use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::body::Body;
use bytes::Bytes;
use futures::StreamExt;
use futures::future::{BoxFuture, FutureExt, Shared};
use http::header::{AUTHORIZATION, CONTENT_TYPE};
use http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use http_body_util::BodyExt;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::contract::{
    Account, AccountKind, AccountQuota, AccountStatus, AccountSummary, ModelFamily, PoolConfig,
    PoolProvider, is_uuid,
};
use crate::limits;
use crate::oauth::{
    CLAUDE_OAUTH_BETA, ConfigGetter, HttpClient, OAuthError, OAuthSecret, TransientRefreshError,
    refresh_oauth,
};
use crate::request::{
    ParsedRequest, parse_claude_request, parse_codex_request, upstream_headers, upstream_url,
};
use crate::store::{AccountSecret, AccountStore, HubTokens, PoolState, now_ms};

const USAGE_REFRESH_INTERVAL_MS: i64 = 5 * 60 * 1_000;
const EXHAUSTED_USAGE_REFRESH_INTERVAL_MS: i64 = 30 * 1_000;
const OAUTH_REFRESH_WINDOW_MS: i64 = 5 * 60 * 1_000;
const MAX_REFRESH_BACKOFF_MS: i64 = 60_000;
const MAX_INLINE_HOLD_MS: i64 = 20_000;
const UPSTREAM_REJECTION_HOLD_MS: i64 = 60_000;
const FAILURE_DETAIL_TIMEOUT_MS: u64 = 250;
const MAX_FAILURE_DETAIL_LENGTH: usize = 1_024;
const FAILOVER_STATUSES: [u16; 8] = [401, 403, 408, 500, 502, 503, 504, 529];
const CODEX_REQUEST_HEADERS: [&str; 10] = [
    "accept",
    "content-encoding",
    "content-type",
    "openai-beta",
    "originator",
    "session-id",
    "session_id",
    "thread-id",
    "user-agent",
    "x-openai-internal-codex-responses-lite",
];
const DROPPED_RESPONSE_HEADERS: [&str; 10] = [
    "content-encoding",
    "content-length",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];
const UNCLASSIFIED_TRANSPORT_ERROR: &str = "unclassified transport error";

/// The streaming HTTP client the proxy path forwards through; `Err` carries a transport error code.
#[async_trait]
pub trait UpstreamClient: Send + Sync {
    async fn send(&self, request: http::Request<Bytes>) -> Result<http::Response<Body>, String>;
}

/// `UpstreamClient` over reqwest: HTTP/1.1 only, proxy variables honoured, bodies untouched.
#[derive(Debug, Clone)]
pub struct ReqwestUpstream {
    client: reqwest::Client,
}

impl ReqwestUpstream {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(Self { client: reqwest::Client::builder().http1_only().build()? })
    }
}

fn transport_code(error: &reqwest::Error) -> String {
    let mut cause: Option<&(dyn std::error::Error + 'static)> = Some(error);
    for _ in 0..6 {
        let Some(current) = cause else { break };
        if let Some(io) = current.downcast_ref::<std::io::Error>() {
            let code = match io.kind() {
                std::io::ErrorKind::ConnectionRefused => "ECONNREFUSED",
                std::io::ErrorKind::ConnectionReset => "ECONNRESET",
                std::io::ErrorKind::ConnectionAborted => "ECONNABORTED",
                std::io::ErrorKind::TimedOut => "ETIMEDOUT",
                std::io::ErrorKind::BrokenPipe => "EPIPE",
                std::io::ErrorKind::NotFound => "ENOTFOUND",
                _ => continue,
            };
            return code.into();
        }
        cause = current.source();
    }
    if error.is_timeout() { "ETIMEDOUT".into() } else { UNCLASSIFIED_TRANSPORT_ERROR.into() }
}

#[async_trait]
impl UpstreamClient for ReqwestUpstream {
    async fn send(&self, request: http::Request<Bytes>) -> Result<http::Response<Body>, String> {
        let request = reqwest::Request::try_from(request)
            .map_err(|_| UNCLASSIFIED_TRANSPORT_ERROR.to_string())?;
        let response =
            self.client.execute(request).await.map_err(|error| transport_code(&error))?;
        let mut builder = http::Response::builder().status(response.status());
        if let Some(headers) = builder.headers_mut() {
            headers.extend(response.headers().clone());
        }
        builder
            .body(Body::from_stream(response.bytes_stream()))
            .map_err(|_| UNCLASSIFIED_TRANSPORT_ERROR.to_string())
    }
}

pub type Warn = Arc<dyn Fn(&str) + Send + Sync>;
pub type Changed = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone)]
pub struct HubDeps {
    pub accounts: Arc<AccountStore>,
    pub tokens: Arc<HubTokens>,
    pub state: Arc<PoolState>,
    pub config: ConfigGetter,
    /// Buffered client for OAuth refreshes and usage polling.
    pub http: Arc<dyn HttpClient>,
    /// Streaming client for proxied model traffic.
    pub upstream: Arc<dyn UpstreamClient>,
    pub warn: Warn,
    pub changed: Changed,
}

struct Upstream {
    name: &'static str,
    allowed: &'static [&'static str],
    prefixes: &'static [&'static str],
    strip: &'static str,
}

fn upstream(provider: PoolProvider) -> Upstream {
    match provider {
        PoolProvider::Claude => Upstream {
            name: "Anthropic",
            allowed: &["accept", "content-type", "user-agent", "x-app"],
            prefixes: &["anthropic-", "x-stainless-"],
            strip: "",
        },
        PoolProvider::Codex => Upstream {
            name: "ChatGPT",
            allowed: &CODEX_REQUEST_HEADERS,
            prefixes: &["x-codex-", "x-stainless-"],
            strip: "v1/",
        },
    }
}

fn base_url(provider: PoolProvider, config: &PoolConfig) -> &str {
    match provider {
        PoolProvider::Claude => &config.anthropic_upstream_base_url,
        PoolProvider::Codex => &config.codex_upstream_base_url,
    }
}

fn observe(
    provider: PoolProvider,
    headers: &HeaderMap,
    previous: &AccountQuota,
    family: ModelFamily,
    now: i64,
) -> AccountQuota {
    match provider {
        PoolProvider::Claude => limits::claude_quota_from_headers(headers, previous, family, now),
        PoolProvider::Codex => limits::codex_quota_from_headers(headers, previous, now),
    }
}

fn is_quota_rejection(provider: PoolProvider, headers: &HeaderMap) -> bool {
    match provider {
        PoolProvider::Claude => limits::is_claude_quota_rejection(headers),
        PoolProvider::Codex => limits::is_codex_quota_rejection(headers),
    }
}

fn error_body(provider: PoolProvider, status: u16, message: &str) -> Value {
    let limited = status == 429;
    match provider {
        PoolProvider::Claude => {
            let kind = match status {
                401 => "authentication_error",
                429 => "rate_limit_error",
                _ => "api_error",
            };
            json!({ "type": "error", "error": { "type": kind, "message": message } })
        }
        PoolProvider::Codex => {
            let kind = if limited { "rate_limit_error" } else { "api_error" };
            let code = if limited { json!("rate_limit_exceeded") } else { Value::Null };
            json!({ "error": { "message": message, "type": kind, "code": code } })
        }
    }
}

#[derive(Debug, Clone)]
struct Failure {
    status: u16,
    message: String,
    retry_after: Option<String>,
}

impl Failure {
    fn new(status: u16, message: impl Into<String>) -> Self {
        Self { status, message: message.into(), retry_after: None }
    }
}

fn error_response(provider: PoolProvider, failure: &Failure) -> axum::response::Response {
    let body = error_body(provider, failure.status, &failure.message).to_string();
    let mut response = http::Response::new(Body::from(body));
    *response.status_mut() =
        StatusCode::from_u16(failure.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if let Some(value) = failure.retry_after.as_deref().and_then(|v| HeaderValue::from_str(v).ok())
    {
        headers.insert(http::header::RETRY_AFTER, value);
    }
    response
}

type Counts = Arc<Mutex<HashMap<String, u64>>>;

struct InFlight {
    counts: Counts,
    id: String,
    released: bool,
}

impl InFlight {
    fn acquire(counts: &Counts, id: &str) -> Self {
        *counts.lock().entry(id.to_string()).or_default() += 1;
        Self { counts: counts.clone(), id: id.to_string(), released: false }
    }

    fn release(&mut self) {
        if std::mem::replace(&mut self.released, true) {
            return;
        }
        let mut counts = self.counts.lock();
        if let Some(count) = counts.get_mut(&self.id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                counts.remove(&self.id);
            }
        }
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.release();
    }
}

struct Flight {
    response: http::Response<Body>,
    guard: InFlight,
}

async fn failure_detail(flight: Flight) -> String {
    let Flight { response, mut guard } = flight;
    let text = async {
        match response.into_body().collect().await {
            Ok(collected) => String::from_utf8_lossy(&collected.to_bytes()).into_owned(),
            Err(_) => String::new(),
        }
    };
    let timeout = Duration::from_millis(FAILURE_DETAIL_TIMEOUT_MS);
    let detail = tokio::time::timeout(timeout, text).await.unwrap_or_default();
    guard.release();
    js_slice(&detail, MAX_FAILURE_DETAIL_LENGTH).trim().to_string()
}

fn js_slice(text: &str, units: usize) -> String {
    let head: Vec<u16> = text.encode_utf16().take(units).collect();
    String::from_utf16_lossy(&head)
}

fn is_event_stream(headers: &HeaderMap) -> bool {
    let content_type = limits::header(headers, "content-type").unwrap_or_default();
    let media = content_type.split(';').next().unwrap_or_default().trim();
    media.eq_ignore_ascii_case("text/event-stream")
}

fn client_response(flight: Flight) -> axum::response::Response {
    let Flight { response, guard } = flight;
    let (parts, body) = response.into_parts();
    let event_stream = is_event_stream(&parts.headers);
    let mut headers = HeaderMap::new();
    for (name, value) in &parts.headers {
        if !DROPPED_RESPONSE_HEADERS.contains(&name.as_str()) {
            headers.append(name.clone(), value.clone());
        }
    }
    let data = body.into_data_stream();
    let stream = futures::stream::unfold(Some((data, guard)), move |state| async move {
        let (mut data, mut guard) = state?;
        match data.next().await {
            Some(Ok(chunk)) => Some((Ok(chunk), Some((data, guard)))),
            None => {
                guard.release();
                None
            }
            Some(Err(error)) => {
                guard.release();
                if !event_stream {
                    return Some((Err(error), None));
                }
                let failure = json!({ "type": "api_error", "message": error.to_string() });
                let data = json!({ "type": "error", "error": failure });
                let frame = format!("event: error\ndata: {data}\n\n");
                Some((Ok(Bytes::from(frame)), None))
            }
        }
    });
    let mut reply = http::Response::new(Body::from_stream(stream));
    *reply.status_mut() = parts.status;
    *reply.headers_mut() = headers;
    reply
}

#[derive(Debug, Clone)]
enum SecretError {
    Transient(TransientRefreshError),
    Failed(String),
}

impl SecretError {
    fn message(&self) -> String {
        match self {
            Self::Transient(error) => error.to_string(),
            Self::Failed(message) => message.clone(),
        }
    }
}

struct Backoff {
    retry_at: i64,
    delay_ms: i64,
    error: TransientRefreshError,
}

type SecretFlight = Shared<BoxFuture<'static, Result<AccountSecret, SecretError>>>;
type UsageFlight = Shared<BoxFuture<'static, ()>>;

struct Route {
    uri: http::Uri,
    method: Method,
    headers: HeaderMap,
    parsed: ParsedRequest,
    provider: PoolProvider,
    family: ModelFamily,
    key: Option<String>,
    parent_key: Option<String>,
    attempted: HashSet<String>,
    waited: HashSet<String>,
    previous: Option<String>,
    pinned: Option<Option<String>>,
}

struct Selection {
    account: Account,
    quota: AccountQuota,
    pinned: bool,
    bound_id: Option<String>,
    active_id: Option<String>,
    eligible: Vec<String>,
    detours: Vec<String>,
}

enum Outcome {
    Response(axum::response::Response),
    Failure(Failure),
    Next,
}

struct Inner {
    deps: HubDeps,
    stopped: CancellationToken,
    epoch_ms: i64,
    started: Instant,
    in_flight: Counts,
    refreshes: Mutex<HashMap<String, SecretFlight>>,
    backoffs: Mutex<HashMap<String, Backoff>>,
    usage_flights: Mutex<HashMap<String, UsageFlight>>,
    usage_refreshed_at: Mutex<HashMap<String, i64>>,
}

/// The reverse proxy pooled agents' model traffic passes through, and the usage poller.
#[derive(Clone)]
pub struct Hub {
    inner: Arc<Inner>,
}

impl Hub {
    pub fn new(deps: HubDeps) -> Self {
        let inner = Inner {
            deps,
            stopped: CancellationToken::new(),
            epoch_ms: now_ms(),
            started: Instant::now(),
            in_flight: Counts::default(),
            refreshes: Mutex::default(),
            backoffs: Mutex::default(),
            usage_flights: Mutex::default(),
            usage_refreshed_at: Mutex::default(),
        };
        Self { inner: Arc::new(inner) }
    }

    /// Cancelling this token makes in-progress and later requests answer 503 (`hub.stopped.abort()`).
    pub fn stopped(&self) -> &CancellationToken {
        &self.inner.stopped
    }

    /// The usage refresh loop; returns when `signal` is cancelled.
    pub async fn start(&self, signal: CancellationToken) {
        let interval = Duration::from_millis(USAGE_REFRESH_INTERVAL_MS as u64);
        while !signal.is_cancelled() {
            self.refresh_usage(None, false).await;
            tokio::select! {
                () = signal.cancelled() => {}
                () = tokio::time::sleep(interval) => {}
            }
        }
    }

    pub async fn refresh_usage(&self, account_id: Option<&str>, recover: bool) {
        let all = account_id.is_none();
        let Ok(accounts) = self.inner.deps.accounts.list().await else { return };
        let interval = if all { USAGE_REFRESH_INTERVAL_MS } else { 0 };
        let flights = accounts
            .into_iter()
            .filter(|account| account.enabled && (all || Some(account.id.as_str()) == account_id))
            .map(|account| self.inner.clone().refresh_account_usage(account, interval, recover));
        futures::future::join_all(flights).await;
    }

    pub async fn summary(&self) -> Vec<AccountSummary> {
        let inner = &self.inner;
        let now = inner.now();
        let threshold = (inner.deps.config)().switch_threshold;
        let accounts = inner.deps.accounts.list().await.unwrap_or_default();
        accounts
            .into_iter()
            .map(|account| {
                let quota = inner.deps.state.quota(&account.id);
                let status = limits::account_status(&account, &quota, threshold, now);
                let reset = limits::blocking_reset_at(&quota, None, threshold, now);
                let blocked_until =
                    if status == AccountStatus::Held { quota.held_until } else { reset };
                let in_flight = inner.in_flight.lock().get(&account.id).copied().unwrap_or(0);
                AccountSummary { account, quota, in_flight, status, blocked_until }
            })
            .collect()
    }

    /// Number of upstream responses for `account_id` whose bodies are still open.
    pub fn in_flight(&self, account_id: &str) -> u64 {
        self.inner.in_flight.lock().get(account_id).copied().unwrap_or(0)
    }

    pub async fn handle(
        &self,
        request: axum::extract::Request,
        provider: PoolProvider,
    ) -> axum::response::Response {
        let reply =
            |status: u16, message: &str| error_response(provider, &Failure::new(status, message));
        let headers = request.headers();
        let authorization = limits::header(headers, "authorization").unwrap_or_default();
        let bearer = bearer_token(&authorization);
        let presented = limits::header(headers, "x-bb-account-pool-token").or(bearer);
        let Some(host_id) = self.inner.deps.tokens.authenticate(presented.as_deref()) else {
            return reply(401, "Invalid Account Pooler bearer token.");
        };
        let stopped = self.inner.stopped.clone();
        let work = async {
            let (parts, body) = request.into_parts();
            let body = axum::body::to_bytes(body, usize::MAX)
                .await
                .map_err(|error| Failure::new(400, error.to_string()))?;
            self.inner.forward(parts, body, provider, host_id).await
        };
        tokio::select! {
            () = stopped.cancelled() => reply(503, "Account Pooler stopped accepting requests."),
            outcome = work => match outcome {
                Ok(response) => response,
                Err(failure) => error_response(provider, &failure),
            },
        }
    }
}

fn bearer_token(authorization: &str) -> Option<String> {
    let (scheme, rest) = authorization.split_at_checked(6)?;
    if !scheme.eq_ignore_ascii_case("bearer") || !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let token = rest.trim_start();
    (!token.is_empty()).then(|| token.to_string())
}

fn store_failure(error: impl std::fmt::Display) -> Failure {
    Failure::new(500, error.to_string())
}

fn seconds(ms: i64) -> String {
    ((ms + 999).div_euclid(1_000)).to_string()
}

impl Inner {
    fn now(&self) -> i64 {
        self.epoch_ms + self.started.elapsed().as_millis() as i64
    }

    fn threshold(&self) -> f64 {
        (self.deps.config)().switch_threshold
    }

    fn is_spent(&self, quota: &AccountQuota, family: Option<ModelFamily>) -> bool {
        limits::is_exhausted(quota, family, self.threshold(), self.now())
    }

    async fn forward(
        self: &Arc<Self>,
        parts: http::request::Parts,
        body: Bytes,
        provider: PoolProvider,
        host_id: String,
    ) -> Result<axum::response::Response, Failure> {
        let parsed = match provider {
            PoolProvider::Claude => parse_claude_request(body),
            PoolProvider::Codex => parse_codex_request(body, &parts.headers),
        };
        let key = |id: &Option<String>| {
            id.as_ref().map(|id| json!([provider.as_str(), host_id, id]).to_string())
        };
        let mut route = Route {
            uri: parts.uri,
            method: parts.method,
            headers: parts.headers,
            family: parsed.family,
            key: key(&parsed.affinity_id),
            parent_key: key(&parsed.parent_affinity_id),
            parsed,
            provider,
            attempted: HashSet::new(),
            waited: HashSet::new(),
            previous: None,
            pinned: None,
        };
        let mut failure: Option<Failure> = None;
        let mut rechecked = false;
        loop {
            let selected = self.select(&mut route).await?;
            let spent = selected
                .as_ref()
                .is_none_or(|selected| self.is_spent(&selected.quota, Some(route.family)));
            if spent && !rechecked {
                rechecked = true;
                self.recheck_exhausted(&route).await?;
                continue;
            }
            let Some(selected) = selected else { break };
            let id = selected.account.id.clone();
            let held_ms = selected.quota.held_until.unwrap_or(0) - self.now();
            if held_ms > 0 && held_ms <= MAX_INLINE_HOLD_MS && !route.waited.contains(&id) {
                route.waited.insert(id);
                tokio::time::sleep(Duration::from_millis(held_ms as u64)).await;
                continue;
            }
            route.attempted.insert(id.clone());
            route.previous = Some(id);
            if held_ms > 0 {
                let message = "The current Account Pooler account is temporarily rate limited.";
                failure = Some(Failure {
                    status: 429,
                    message: message.into(),
                    retry_after: Some(seconds(held_ms)),
                });
                if selected.pinned {
                    break;
                }
                continue;
            }
            match self.attempt(&selected, &route).await {
                Outcome::Response(response) => return Ok(response),
                Outcome::Failure(next) => failure = Some(next),
                Outcome::Next => {}
            }
        }
        let failure = match failure {
            Some(failure) => failure,
            None => self.no_eligible(&route).await?,
        };
        Ok(error_response(provider, &failure))
    }

    async fn attempt(self: &Arc<Self>, selected: &Selection, route: &Route) -> Outcome {
        let account = &selected.account;
        let id = account.id.as_str();
        let state = &self.deps.state;
        let upstream = upstream(route.provider);
        let mut secret = match self.clone().fresh_secret(account.clone(), None).await {
            Ok(secret) => secret,
            Err(error) => {
                return self.refresh_failure(id, &error).map_or(Outcome::Next, Outcome::Failure);
            }
        };
        let body = route.parsed.for_account(account);
        let mut paced = route.waited.contains(id);
        let mut auth_retried = false;
        loop {
            let Some(flight) = self.send(route, body.clone(), account, &secret).await else {
                let message = format!("Account Pooler could not reach {}.", upstream.name);
                return Outcome::Failure(Failure::new(502, message));
            };
            let status = flight.response.status().as_u16();
            let headers = flight.response.headers().clone();
            let now = self.now();
            let seen = observe(route.provider, &headers, &state.quota(id), route.family, now);
            state.set_quota(id, Some(seen.clone()));
            let retry_after = limits::header(&headers, "retry-after");
            if status == 429 && is_quota_rejection(route.provider, &headers) {
                drop(flight);
                if !self.is_spent(&seen, Some(route.family)) {
                    state.set_quota(id, Some(limits::blocked(&seen, now)));
                }
                return Outcome::Next;
            }
            if status == 429 {
                let wait_ms = limits::retry_after_ms(retry_after.as_deref(), now);
                state.set_quota(id, Some(AccountQuota { held_until: Some(now + wait_ms), ..seen }));
                if !paced && wait_ms <= MAX_INLINE_HOLD_MS {
                    paced = true;
                    drop(flight);
                    tokio::time::sleep(Duration::from_millis(wait_ms as u64)).await;
                    continue;
                }
                if !selected.pinned {
                    let message = failure_detail(flight).await;
                    let retry_after = Some(seconds(wait_ms));
                    return Outcome::Failure(Failure { status, message, retry_after });
                }
            }
            if !FAILOVER_STATUSES.contains(&status) {
                if flight.response.status().is_success() {
                    self.commit(selected, route);
                }
                return Outcome::Response(client_response(flight));
            }
            let detail = failure_detail(flight).await;
            let message = if detail.is_empty() {
                format!("{} returned HTTP {status}.", upstream.name)
            } else {
                detail
            };
            let failure = Failure { status, message: message.clone(), retry_after };
            if status != 401 && status != 403 {
                return Outcome::Failure(failure);
            }
            let AccountSecret::OAuth { access_token, .. } = &secret else {
                self.mark_error(id, &message);
                return Outcome::Failure(failure);
            };
            if auth_retried {
                let held_until = Some(self.now() + UPSTREAM_REJECTION_HOLD_MS);
                state.set_quota(id, Some(AccountQuota { held_until, ..state.quota(id) }));
                let reason = format!(
                    "{} returned HTTP {status} for a freshly refreshed credential, so the Account Pooler is treating it as an upstream failure",
                    upstream.name
                );
                return Outcome::Failure(Failure::new(503, format!("{reason}: {message}")));
            }
            auth_retried = true;
            let rejected = Some(access_token.clone());
            match self.clone().fresh_secret(account.clone(), rejected).await {
                Ok(next) => secret = next,
                Err(error) => {
                    return Outcome::Failure(self.refresh_failure(id, &error).unwrap_or(failure));
                }
            }
        }
    }

    async fn send(
        &self,
        route: &Route,
        body: Bytes,
        account: &Account,
        secret: &AccountSecret,
    ) -> Option<Flight> {
        let provider = account.provider;
        let upstream = upstream(provider);
        let mut headers = upstream_headers(&route.headers, upstream.allowed, upstream.prefixes);
        let set = |headers: &mut HeaderMap, name: HeaderName, value: &str| {
            if let Ok(value) = HeaderValue::from_str(value) {
                headers.insert(name, value);
            }
        };
        match secret {
            AccountSecret::ApiKey { api_key } => {
                set(&mut headers, HeaderName::from_static("x-api-key"), api_key);
            }
            AccountSecret::OAuth { access_token, .. } => {
                set(&mut headers, AUTHORIZATION, &format!("Bearer {access_token}"));
            }
        }
        if provider == PoolProvider::Codex {
            let account_id = account.codex_account_id.as_deref().unwrap_or("");
            set(&mut headers, HeaderName::from_static("chatgpt-account-id"), account_id);
        }
        let method = route.method.clone();
        let payload =
            if method == Method::GET || method == Method::HEAD { Bytes::new() } else { body };
        let mut guard = InFlight::acquire(&self.in_flight, &account.id);
        let config = (self.deps.config)();
        let url = match upstream_url(&route.uri, base_url(provider, &config), upstream.strip) {
            Ok(url) => url,
            Err(_) => {
                guard.release();
                let warning = format!(
                    "Account Pooler {} transport failed: {UNCLASSIFIED_TRANSPORT_ERROR}.",
                    provider.as_str()
                );
                (self.deps.warn)(&warning);
                return None;
            }
        };
        let mut request = http::Request::new(payload);
        *request.method_mut() = method;
        *request.headers_mut() = headers;
        *request.uri_mut() = url.as_str().parse().ok()?;
        match self.deps.upstream.send(request).await {
            Ok(response) => Some(Flight { response, guard }),
            Err(code) => {
                guard.release();
                let warning =
                    format!("Account Pooler {} transport failed: {code}.", provider.as_str());
                (self.deps.warn)(&warning);
                None
            }
        }
    }

    async fn select(&self, route: &mut Route) -> Result<Option<Selection>, Failure> {
        let state = &self.deps.state;
        let provider = route.provider;
        let now = self.now();
        let family = Some(route.family);
        let accounts: Vec<Account> = self
            .deps
            .accounts
            .list()
            .await
            .map_err(store_failure)?
            .into_iter()
            .filter(|account| account.provider == provider)
            .collect();
        let usable = |quota: &AccountQuota, scope: Option<ModelFamily>| {
            !self.is_spent(quota, scope) || quota.extra_usage == Some(true)
        };
        let available: Vec<(Account, AccountQuota)> = accounts
            .iter()
            .filter(|account| account.enabled)
            .map(|account| (account.clone(), state.quota(&account.id)))
            .filter(|(_, quota)| quota.error.is_none() && usable(quota, None))
            .collect();
        let fresh = |account: &Account| !route.attempted.contains(&account.id);
        let ready = |quota: &AccountQuota| quota.held_until.unwrap_or(0) <= now;
        let paid: Vec<&(Account, AccountQuota)> =
            available.iter().filter(|(_, quota)| usable(quota, family)).collect();
        let included: Vec<&(Account, AccountQuota)> =
            paid.iter().copied().filter(|(_, quota)| !self.is_spent(quota, family)).collect();
        let preferred = included.iter().any(|(account, quota)| fresh(account) && ready(quota));
        let eligible = if preferred { included } else { paid };
        let unattempted: Vec<&(Account, AccountQuota)> =
            eligible.iter().copied().filter(|(account, _)| fresh(account)).collect();
        let find = |id: Option<&str>| {
            unattempted.iter().copied().find(|(account, _)| Some(account.id.as_str()) == id)
        };
        let is_eligible =
            |id: Option<&str>| eligible.iter().any(|(account, _)| Some(account.id.as_str()) == id);
        let bound_id = state.bound_account(route.key.as_deref());
        let parent_id = if is_eligible(bound_id.as_deref()) {
            None
        } else {
            state.bound_account(route.parent_key.as_deref())
        };
        let active_id = state.active(provider);
        let anchor_id = route.previous.clone().or(bound_id.clone()).or(active_id.clone());
        let anchor = accounts
            .iter()
            .position(|account| Some(&account.id) == anchor_id.as_ref())
            .map_or(0, |index| index + 1);
        let ring = accounts[anchor..].iter().chain(&accounts[..anchor]);
        let next =
            ring.filter_map(|account| find(Some(&account.id))).find(|(_, quota)| ready(quota));
        let sticky = bound_id.is_none() && route.previous.is_none();
        let inherited = find(parent_id.as_deref());
        let chosen = find(bound_id.as_deref())
            .or(inherited)
            .or_else(|| if sticky { find(active_id.as_deref()) } else { None })
            .or(next);
        let Some((account, quota)) = chosen.cloned() else { return Ok(None) };
        let id = account.id.clone();
        if route.pinned.is_none() {
            let inherited_id = inherited.map(|(account, _)| account.id.clone());
            route.pinned = Some(bound_id.clone().or(inherited_id));
        }
        if let Some(key) = &route.key
            && bound_id.as_ref().is_none_or(|bound| *bound == id)
        {
            state.bind(key, &id);
        }
        if active_id.is_none() {
            state.set_active(provider, &id);
        }
        let detours = available
            .iter()
            .filter(|(_, quota)| !self.is_spent(quota, None) && self.is_spent(quota, family))
            .map(|(account, _)| account.id.clone())
            .collect();
        let eligible = eligible.iter().map(|(account, _)| account.id.clone()).collect();
        let pinned = route.pinned.as_ref().is_some_and(|pinned| pinned.as_ref() == Some(&id));
        Ok(Some(Selection { account, quota, pinned, bound_id, active_id, eligible, detours }))
    }

    fn commit(&self, selected: &Selection, route: &Route) {
        let state = &self.deps.state;
        let id = &selected.account.id;
        let detoured =
            |account_id: Option<&String>| account_id.is_some_and(|a| selected.detours.contains(a));
        if let Some(key) = &route.key
            && !detoured(selected.bound_id.as_ref())
        {
            state.bind(key, id);
        }
        let active_id = selected.active_id.as_ref();
        let failed = active_id.is_some_and(|active| route.attempted.contains(active));
        let eligible = active_id.is_some_and(|active| selected.eligible.contains(active));
        let moved = failed || active_id == Some(id) || !eligible;
        if moved && !detoured(active_id) {
            state.set_active(route.provider, id);
        }
        state.touch();
    }

    async fn recheck_exhausted(self: &Arc<Self>, route: &Route) -> Result<(), Failure> {
        let accounts = self.deps.accounts.list().await.map_err(store_failure)?;
        let flights = accounts
            .into_iter()
            .filter(|account| {
                let quota = self.deps.state.quota(&account.id);
                let candidate = account.provider == route.provider
                    && account.enabled
                    && !route.attempted.contains(&account.id);
                candidate && quota.error.is_none() && self.is_spent(&quota, Some(route.family))
            })
            .map(|account| {
                self.clone().refresh_account_usage(
                    account,
                    EXHAUSTED_USAGE_REFRESH_INTERVAL_MS,
                    false,
                )
            });
        futures::future::join_all(flights).await;
        Ok(())
    }

    async fn no_eligible(&self, route: &Route) -> Result<Failure, Failure> {
        let state = &self.deps.state;
        let enabled: Vec<Account> = self
            .deps
            .accounts
            .list()
            .await
            .map_err(store_failure)?
            .into_iter()
            .filter(|account| account.provider == route.provider && account.enabled)
            .collect();
        if enabled.is_empty() {
            return Ok(Failure::new(503, "Account Pooler has no enabled account"));
        }
        let now = self.now();
        let threshold = self.threshold();
        let next = enabled
            .iter()
            .filter_map(|account| {
                let quota = state.quota(&account.id);
                let reset = limits::blocking_reset_at(&quota, Some(route.family), threshold, now);
                let reset_at = quota.held_until.unwrap_or(0).max(reset.unwrap_or(0));
                (quota.error.is_none() && reset_at > now).then_some(reset_at)
            })
            .min()
            .unwrap_or(now + 1_000);
        let retry_after = Some((((next - now) + 999).div_euclid(1_000)).max(1).to_string());
        let message = "No Account Pooler account is currently eligible.".to_string();
        Ok(Failure { status: 429, message, retry_after })
    }

    fn mark_error(&self, account_id: &str, message: &str) {
        let quota = self.deps.state.quota(account_id);
        let error = js_slice(message, 1_000);
        self.deps.state.set_quota(account_id, Some(AccountQuota { error: Some(error), ..quota }));
        (self.deps.changed)();
    }

    fn refresh_failure(&self, account_id: &str, error: &SecretError) -> Option<Failure> {
        let message = error.message();
        if matches!(error, SecretError::Transient(_)) {
            return Some(Failure::new(503, message));
        }
        self.mark_error(account_id, &message);
        None
    }

    async fn fresh_secret(
        self: Arc<Self>,
        account: Account,
        rejected_token: Option<String>,
    ) -> Result<AccountSecret, SecretError> {
        loop {
            let running = self.refreshes.lock().get(&account.id).cloned();
            let Some(running) = running else { break };
            let secret = running.await?;
            let stale = matches!(&secret, AccountSecret::OAuth { access_token, .. }
                if Some(access_token) == rejected_token.as_ref());
            if !stale {
                return Ok(secret);
            }
        }
        let id = account.id.clone();
        let key = id.clone();
        let inner = self.clone();
        let flight = async move {
            let result = inner.clone().load_secret(account, rejected_token).await;
            inner.refreshes.lock().remove(&key);
            result
        }
        .boxed()
        .shared();
        self.refreshes.lock().insert(id, flight.clone());
        tokio::spawn(flight.clone());
        flight.await
    }

    async fn load_secret(
        self: Arc<Self>,
        account: Account,
        rejected_token: Option<String>,
    ) -> Result<AccountSecret, SecretError> {
        let id = account.id.as_str();
        let secret = self
            .deps
            .accounts
            .read_secret(id)
            .await
            .map_err(|error| SecretError::Failed(error.to_string()))?;
        let Some(oauth) = OAuthSecret::from_secret(&secret) else { return Ok(secret) };
        let now = self.now();
        let forced = Some(&oauth.access_token) == rejected_token.as_ref();
        let expires_at = oauth.expires_at.unwrap_or(i64::MAX);
        if !forced && expires_at > now.saturating_add(OAUTH_REFRESH_WINDOW_MS) {
            return Ok(secret);
        }
        let usable = !forced && expires_at > now;
        let previous = self
            .backoffs
            .lock()
            .get(id)
            .map(|backoff| (backoff.retry_at, backoff.delay_ms, backoff.error.clone()));
        if let Some((retry_at, _, error)) = &previous
            && now < *retry_at
        {
            return if usable { Ok(secret) } else { Err(SecretError::Transient(error.clone())) };
        }
        let config = (self.deps.config)();
        match refresh_oauth(account.provider, &oauth, &config, self.deps.http.as_ref()).await {
            Ok(refreshed) => {
                let refreshed = AccountSecret::from(refreshed);
                self.deps
                    .accounts
                    .write_secret(id, &refreshed)
                    .await
                    .map_err(|error| SecretError::Failed(error.to_string()))?;
                self.backoffs.lock().remove(id);
                Ok(refreshed)
            }
            Err(OAuthError::Failed(message)) => Err(SecretError::Failed(message)),
            Err(OAuthError::Transient(error)) => {
                let doubled = previous.map_or(1_000, |(_, delay_ms, _)| delay_ms * 2);
                let delay_ms = MAX_REFRESH_BACKOFF_MS.min(doubled.max(error.retry_after_ms));
                let backoff = Backoff { retry_at: now + delay_ms, delay_ms, error: error.clone() };
                self.backoffs.lock().insert(id.to_string(), backoff);
                if usable { Ok(secret) } else { Err(SecretError::Transient(error)) }
            }
        }
    }

    async fn refresh_account_usage(
        self: Arc<Self>,
        account: Account,
        min_interval_ms: i64,
        recover: bool,
    ) {
        let id = account.id.clone();
        let busy = account.kind != AccountKind::OAuth || self.in_flight.lock().contains_key(&id);
        let running = self.usage_flights.lock().get(&id).cloned();
        if busy || running.is_some() {
            if let Some(running) = running {
                running.await;
            }
            return;
        }
        let now = self.now();
        {
            let mut refreshed = self.usage_refreshed_at.lock();
            if refreshed.get(&id).is_some_and(|last| now - last < min_interval_ms) {
                return;
            }
            refreshed.insert(id.clone(), now);
        }
        let inner = self.clone();
        let key = id.clone();
        let flight = async move {
            inner.poll_usage(&account, recover).await;
            inner.usage_flights.lock().remove(&key);
            (inner.deps.changed)();
        }
        .boxed()
        .shared();
        self.usage_flights.lock().insert(id, flight.clone());
        tokio::spawn(flight.clone());
        flight.await;
    }

    async fn poll_usage(self: &Arc<Self>, account: &Account, recover: bool) {
        let state = &self.deps.state;
        let id = account.id.as_str();
        let claude = account.provider == PoolProvider::Claude;
        let failed = state.quota(id).error.is_some();
        if failed && !recover {
            return;
        }
        let rejected = if failed {
            match self.deps.accounts.read_secret(id).await {
                Ok(AccountSecret::OAuth { access_token, .. }) => Some(access_token),
                Ok(_) => None,
                Err(_) => return,
            }
        } else {
            None
        };
        let secret = match self.clone().fresh_secret(account.clone(), rejected).await {
            Ok(secret) => secret,
            Err(error) => {
                self.refresh_failure(id, &error);
                return;
            }
        };
        let AccountSecret::OAuth { access_token, .. } = secret else { return };
        if failed {
            state.set_quota(id, Some(AccountQuota { error: None, ..state.quota(id) }));
        }
        let mut headers = HeaderMap::new();
        let mut set = |name: &'static str, value: &str| {
            if let Ok(value) = HeaderValue::from_str(value) {
                headers.insert(HeaderName::from_static(name), value);
            }
        };
        set("authorization", &format!("Bearer {access_token}"));
        set("accept", "application/json");
        if claude {
            set("anthropic-beta", CLAUDE_OAUTH_BETA);
        } else {
            set("chatgpt-account-id", account.codex_account_id.as_deref().unwrap_or(""));
            set("originator", "bb");
        }
        let config = (self.deps.config)();
        let claude_base = config.anthropic_upstream_base_url.as_str();
        let codex_base = config.codex_upstream_base_url.trim_end_matches('/');
        let usage_url = if claude {
            url::Url::parse(claude_base).and_then(|base| base.join("/api/oauth/usage"))
        } else {
            url::Url::parse(codex_base).and_then(|base| base.join("wham/usage"))
        };
        let Ok(usage_url) = usage_url else { return };
        let Ok(usage) = self.get_json(usage_url, &headers, claude).await else { return };
        let read =
            if claude { limits::claude_quota_from_usage } else { limits::codex_quota_from_usage };
        if let Some(quota) = read(&usage, &state.quota(id), self.now()) {
            state.set_quota(id, Some(quota));
        }
        let plan = limits::dig(&usage, &["plan_type"])
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|plan| !plan.is_empty());
        if !claude
            && let Some(plan) = plan
            && Some(plan) != account.subscription_type.as_deref()
        {
            let plan = plan.to_string();
            let _ = self
                .deps
                .accounts
                .update(id, move |account| account.subscription_type = Some(plan))
                .await;
        }
        if !claude || account.account_uuid.is_some() {
            return;
        }
        let Ok(profile_url) =
            url::Url::parse(claude_base).and_then(|base| base.join("/api/oauth/profile"))
        else {
            return;
        };
        let Ok(profile) = self.get_json(profile_url, &headers, claude).await else { return };
        let uuid = limits::dig(&profile, &["account", "uuid"]).and_then(Value::as_str);
        if let Some(uuid) = uuid.filter(|uuid| is_uuid(uuid)) {
            let uuid = uuid.to_string();
            let _ = self
                .deps
                .accounts
                .update(id, move |account| account.account_uuid = Some(uuid))
                .await;
        }
    }

    async fn get_json(
        &self,
        url: url::Url,
        headers: &HeaderMap,
        claude: bool,
    ) -> Result<Value, ()> {
        let mut request = http::Request::new(Bytes::new());
        *request.headers_mut() = headers.clone();
        *request.uri_mut() = url.as_str().parse().map_err(|_| ())?;
        let timeout = Duration::from_millis(if claude { 10_000 } else { 15_000 });
        let response = tokio::time::timeout(timeout, self.deps.http.send(request))
            .await
            .map_err(|_| ())?
            .map_err(|_| ())?;
        if !response.status().is_success() {
            return Ok(Value::Null);
        }
        Ok(serde_json::from_slice(response.body()).unwrap_or(Value::Null))
    }
}
