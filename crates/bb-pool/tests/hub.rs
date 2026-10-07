use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use axum::body::Body;
use bb_pool::contract::{AccountKind, PoolConfig, PoolProvider};
use bb_pool::hub::{Hub, HubDeps, UpstreamClient};
use bb_pool::oauth::HttpClient;
use bb_pool::store::{
    AccountSecret, AccountStore, HubTokens, MemoryKv, NewAccount, PoolState, now_ms,
};
use bytes::Bytes;
use futures::StreamExt;
use futures::channel::mpsc;
use http_body_util::BodyExt;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

const LIMIT: &str = "anthropic-ratelimit-unified";
const UUID_A: &str = "00000000-0000-4000-8000-00000000000a";
const UUID_B: &str = "00000000-0000-4000-8000-00000000000b";
const UUID_CLIENT: &str = "00000000-0000-4000-8000-000000000009";

type Handler = Box<dyn Fn(&http::Request<Bytes>) -> http::Response<Body> + Send + Sync>;

struct FakeUpstream {
    seen: Mutex<Vec<http::Request<Bytes>>>,
    handler: Mutex<Handler>,
}

#[async_trait]
impl UpstreamClient for FakeUpstream {
    async fn send(&self, request: http::Request<Bytes>) -> Result<http::Response<Body>, String> {
        let response = (self.handler.lock())(&request);
        self.seen.lock().push(request);
        Ok(response)
    }
}

impl FakeUpstream {
    fn tokens(&self) -> Vec<String> {
        let seen = self.seen.lock();
        seen.iter()
            .map(|request| {
                let auth = request.headers().get("authorization").and_then(|v| v.to_str().ok());
                auth.unwrap_or_default().trim_start_matches("Bearer ").to_string()
            })
            .collect()
    }
}

#[derive(Default)]
struct FakeHttp {
    refreshes: AtomicUsize,
    usage: AtomicUsize,
    refused: std::sync::atomic::AtomicBool,
}

#[async_trait]
impl HttpClient for FakeHttp {
    async fn send(&self, request: http::Request<Bytes>) -> Result<http::Response<Bytes>, String> {
        if request.uri().path().ends_with("/api/oauth/usage") {
            self.usage.fetch_add(1, Ordering::SeqCst);
            let usage = json!({ "five_hour": { "utilization": 10, "resets_at": null } });
            return Ok(http::Response::new(Bytes::from(usage.to_string())));
        }
        let count = self.refreshes.fetch_add(1, Ordering::SeqCst) + 1;
        tokio::time::sleep(Duration::from_millis(50)).await;
        if self.refused.load(Ordering::SeqCst) {
            let mut response = http::Response::new(Bytes::from_static(b"{}"));
            *response.status_mut() = http::StatusCode::BAD_REQUEST;
            return Ok(response);
        }
        let reply = json!({
            "access_token": format!("access-{}", count + 1),
            "refresh_token": "refresh-next",
            "expires_in": 3600,
        });
        Ok(http::Response::new(Bytes::from(reply.to_string())))
    }
}

struct Harness {
    hub: Hub,
    accounts: Arc<AccountStore>,
    state: Arc<PoolState>,
    token: String,
    upstream: Arc<FakeUpstream>,
    http: Arc<FakeHttp>,
    _dir: tempfile::TempDir,
}

fn reply(status: u16, headers: &[(&str, &str)], body: impl Into<Body>) -> http::Response<Body> {
    let mut response = http::Response::new(body.into());
    *response.status_mut() = http::StatusCode::from_u16(status).expect("status");
    for (name, value) in headers {
        let name = http::HeaderName::from_bytes(name.as_bytes()).expect("name");
        response.headers_mut().append(name, value.parse().expect("value"));
    }
    response
}

async fn harness(handler: Handler) -> Harness {
    let dir = tempfile::tempdir().expect("tempdir");
    let accounts =
        Arc::new(AccountStore::new(Arc::new(MemoryKv::new()), dir.path().join("secrets")));
    let tokens = Arc::new(HubTokens::new(dir.path().join("secrets")));
    let token = tokens.for_host("host-1").await.expect("token");
    let state = Arc::new(PoolState::new(dir.path().join("state.json")));
    let upstream = Arc::new(FakeUpstream { seen: Mutex::default(), handler: Mutex::new(handler) });
    let http = Arc::new(FakeHttp::default());
    let config = PoolConfig { switch_threshold: 0.9, ..PoolConfig::default() };
    let hub = Hub::new(HubDeps {
        accounts: accounts.clone(),
        tokens,
        state: state.clone(),
        config: Arc::new(move || config.clone()),
        http: http.clone(),
        upstream: upstream.clone(),
        warn: Arc::new(|_| {}),
        changed: Arc::new(|| {}),
    });
    Harness { hub, accounts, state, token, upstream, http, _dir: dir }
}

impl Harness {
    async fn add(
        &self,
        provider: PoolProvider,
        uuid: &str,
        priority: i64,
        secret: AccountSecret,
    ) -> String {
        let kind = match secret {
            AccountSecret::OAuth { .. } => AccountKind::OAuth,
            AccountSecret::ApiKey { .. } => AccountKind::ApiKey,
        };
        let input = NewAccount {
            provider,
            kind,
            label: format!("account {priority}"),
            email: None,
            account_uuid: Some(uuid.to_string()),
            codex_account_id: None,
            subscription_type: None,
            rate_limit_tier: None,
            enabled: true,
            priority,
        };
        self.accounts.add(input, &secret).await.expect("add").id
    }

    async fn call(&self, provider: PoolProvider, token: &str, body: Value) -> http::Response<Body> {
        let request = http::Request::builder()
            .method("POST")
            .uri("http://127.0.0.1/api/v1/plugins/account-pool/http/v1/messages")
            .header("x-bb-account-pool-token", token)
            .header("authorization", "Bearer local-login")
            .header("x-custom", "dropped")
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .expect("request");
        self.hub.handle(request, provider).await
    }

    async fn message(&self, session: &str) -> http::Response<Body> {
        let user = json!({ "account_uuid": UUID_CLIENT, "session_id": session }).to_string();
        let body = json!({ "model": "claude-sonnet-4-5", "metadata": { "user_id": user } });
        self.call(PoolProvider::Claude, &self.token.clone(), body).await
    }
}

fn oauth(access: &str, expires_in_ms: i64) -> AccountSecret {
    AccountSecret::OAuth {
        access_token: access.into(),
        refresh_token: "refresh-1".into(),
        expires_at: Some(now_ms() + expires_in_ms),
        id_token: None,
    }
}

fn key(name: &str) -> AccountSecret {
    AccountSecret::ApiKey { api_key: name.into() }
}

async fn json_body(response: http::Response<Body>) -> Value {
    let bytes = response.into_body().collect().await.expect("body").to_bytes();
    serde_json::from_slice(&bytes).expect("json")
}

fn ok() -> Handler {
    Box::new(|_| reply(200, &[("content-type", "application/json")], "{}"))
}

#[tokio::test]
async fn rejects_an_unknown_hub_token() {
    let hub = harness(ok()).await;
    hub.add(PoolProvider::Claude, UUID_A, 0, key("a")).await;
    let response = hub.call(PoolProvider::Claude, "wrong", json!({})).await;
    assert_eq!(response.status(), 401);
    let body = json_body(response).await;
    let error = json!({ "type": "authentication_error", "message": "Invalid Account Pooler bearer token." });
    assert_eq!(body, json!({ "type": "error", "error": error }));
    assert!(hub.upstream.seen.lock().is_empty());
}

#[tokio::test]
async fn routes_to_the_highest_priority_account_and_streams_unbuffered() {
    let (sender, receiver) = mpsc::unbounded::<Result<Bytes, std::io::Error>>();
    let receiver = Mutex::new(Some(receiver));
    let hub = harness(Box::new(move |_| {
        let stream = receiver.lock().take().expect("one request");
        let headers = [
            ("content-type", "text/event-stream"),
            ("content-length", "999"),
            ("connection", "keep-alive"),
            ("anthropic-ratelimit-unified-5h-utilization", "0.25"),
        ];
        reply(200, &headers, Body::from_stream(stream))
    }))
    .await;
    let second = hub.add(PoolProvider::Claude, UUID_B, 2, oauth("access-b", 3_600_000)).await;
    let first = hub.add(PoolProvider::Claude, UUID_A, 1, oauth("access-a", 3_600_000)).await;
    let response = hub.message("s1").await;
    assert_eq!(response.status(), 200);
    assert!(response.headers().get("content-length").is_none());
    assert!(response.headers().get("connection").is_none());
    assert_eq!(hub.hub.in_flight(&first), 1);
    let mut body = response.into_body().into_data_stream();
    sender.unbounded_send(Ok(Bytes::from_static(b"event: one\n\n"))).expect("send");
    let chunk = body.next().await.expect("chunk").expect("data");
    assert_eq!(chunk, Bytes::from_static(b"event: one\n\n"));
    assert_eq!(hub.hub.in_flight(&first), 1);
    drop(sender);
    assert!(body.next().await.is_none());
    assert_eq!(hub.hub.in_flight(&first), 0);
    assert_eq!(hub.hub.in_flight(&second), 0);

    let seen = hub.upstream.seen.lock();
    let posted = &seen[0];
    assert_eq!(posted.uri().to_string(), "https://api.anthropic.com/v1/messages");
    assert_eq!(posted.headers()["authorization"], "Bearer access-a");
    assert_eq!(posted.headers()["anthropic-version"], "2023-06-01");
    assert!(posted.headers().get("x-bb-account-pool-token").is_none());
    assert!(posted.headers().get("x-custom").is_none());
    let sent: Value = serde_json::from_slice(posted.body()).expect("json");
    let user: Value =
        serde_json::from_str(sent["metadata"]["user_id"].as_str().expect("user")).expect("user");
    assert_eq!(user, json!({ "account_uuid": UUID_A, "session_id": "s1" }));
    let quota = hub.state.quota(&first);
    assert_eq!(quota.windows[0].utilization, Some(0.25));
}

#[tokio::test]
async fn releases_in_flight_when_the_client_drops_the_body() {
    let (_sender, receiver) = mpsc::unbounded::<Result<Bytes, std::io::Error>>();
    let receiver = Mutex::new(Some(receiver));
    let hub = harness(Box::new(move |_| {
        let stream = receiver.lock().take().expect("one request");
        reply(200, &[("content-type", "text/event-stream")], Body::from_stream(stream))
    }))
    .await;
    let id = hub.add(PoolProvider::Claude, UUID_A, 0, key("a")).await;
    let response = hub.message("s1").await;
    assert_eq!(hub.hub.in_flight(&id), 1);
    drop(response);
    assert_eq!(hub.hub.in_flight(&id), 0);
}

#[tokio::test]
async fn switches_accounts_at_the_threshold_and_keeps_sessions_sticky() {
    let reset = ((now_ms() + 3_600_000) / 1_000).to_string();
    let hub = harness(Box::new(move |request| {
        let near = request.headers()["x-api-key"] == "a";
        let utilization = if near { "0.95" } else { "0.10" };
        let headers = [
            (format!("{LIMIT}-5h-utilization"), utilization.to_string()),
            (format!("{LIMIT}-5h-reset"), reset.clone()),
        ];
        let headers: Vec<(&str, &str)> =
            headers.iter().map(|(n, v)| (n.as_str(), v.as_str())).collect();
        reply(200, &headers, "{}")
    }))
    .await;
    let first = hub.add(PoolProvider::Claude, UUID_A, 0, key("a")).await;
    let second = hub.add(PoolProvider::Claude, UUID_B, 1, key("b")).await;
    assert_eq!(hub.message("s1").await.status(), 200);
    assert_eq!(hub.message("s2").await.status(), 200);
    assert_eq!(hub.message("s1").await.status(), 200);
    let keys: Vec<String> = hub
        .upstream
        .seen
        .lock()
        .iter()
        .map(|r| r.headers()["x-api-key"].to_str().expect("key").to_string())
        .collect();
    assert_eq!(keys, ["a", "b", "b"]);
    let summary = hub.hub.summary().await;
    let status = |id: &str| summary.iter().find(|s| s.account.id == id).map(|s| s.status);
    assert_eq!(status(&first), Some(bb_pool::contract::AccountStatus::Exhausted));
    assert_eq!(status(&second), Some(bb_pool::contract::AccountStatus::Ready));
}

#[tokio::test]
async fn fails_over_on_a_listed_status() {
    let hub = harness(Box::new(|request| {
        if request.headers()["x-api-key"] == "a" {
            reply(529, &[], "overloaded")
        } else {
            reply(200, &[], "{}")
        }
    }))
    .await;
    hub.add(PoolProvider::Claude, UUID_A, 0, key("a")).await;
    hub.add(PoolProvider::Claude, UUID_B, 1, key("b")).await;
    assert_eq!(hub.message("s1").await.status(), 200);
    assert_eq!(hub.upstream.seen.lock().len(), 2);
}

#[tokio::test]
async fn a_quota_rejection_blocks_the_account_and_rotates() {
    let reset = (now_ms() / 1_000 + 3_600).to_string();
    let hub = harness(Box::new(move |request| {
        if request.headers()["x-api-key"] == "a" {
            let headers = [
                ("anthropic-ratelimit-unified-5h-status", "rejected"),
                ("anthropic-ratelimit-unified-5h-reset", reset.as_str()),
            ];
            reply(429, &headers, "limited")
        } else {
            reply(200, &[], "{}")
        }
    }))
    .await;
    let first = hub.add(PoolProvider::Claude, UUID_A, 0, key("a")).await;
    hub.add(PoolProvider::Claude, UUID_B, 1, key("b")).await;
    assert_eq!(hub.message("s1").await.status(), 200);
    assert_eq!(hub.message("s2").await.status(), 200);
    assert_eq!(hub.upstream.seen.lock().len(), 3);
    let summary = hub.hub.summary().await;
    let blocked = summary.iter().find(|s| s.account.id == first).expect("account");
    assert_eq!(blocked.status, bb_pool::contract::AccountStatus::Exhausted);
    assert!(blocked.blocked_until.is_some());
}

#[tokio::test]
async fn refreshes_an_expiring_token_once_before_forwarding() {
    let hub = harness(ok()).await;
    let id = hub.add(PoolProvider::Claude, UUID_A, 0, oauth("access-1", 60_000)).await;
    let (one, two) = tokio::join!(hub.message("s1"), hub.message("s2"));
    assert_eq!((one.status().as_u16(), two.status().as_u16()), (200, 200));
    assert_eq!(hub.http.refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(hub.upstream.tokens(), ["access-2", "access-2"]);
    let stored = hub.accounts.read_secret(&id).await.expect("secret");
    assert!(
        matches!(stored, AccountSecret::OAuth { access_token, .. } if access_token == "access-2")
    );
}

#[tokio::test]
async fn retries_a_rejected_token_after_one_forced_refresh() {
    let hub = harness(Box::new(|request| {
        if request.headers()["authorization"] == "Bearer access-1" {
            reply(401, &[], "expired")
        } else {
            reply(200, &[], "{}")
        }
    }))
    .await;
    hub.add(PoolProvider::Claude, UUID_A, 0, oauth("access-1", 3_600_000)).await;
    assert_eq!(hub.message("s1").await.status(), 200);
    assert_eq!(hub.upstream.tokens(), ["access-1", "access-2"]);
}

#[tokio::test]
async fn marks_an_account_whose_refresh_is_refused() {
    let hub = harness(ok()).await;
    hub.http.refused.store(true, Ordering::SeqCst);
    let id = hub.add(PoolProvider::Claude, UUID_A, 0, oauth("access-1", 0)).await;
    let response = hub.message("s1").await;
    assert_eq!(response.status(), 429);
    assert_eq!(hub.state.quota(&id).error.as_deref(), Some("OAuth refresh failed with HTTP 400."));
    assert!(hub.upstream.seen.lock().is_empty());
}

#[tokio::test]
async fn answers_no_eligible_account_per_provider() {
    let hub = harness(ok()).await;
    let response =
        hub.call(PoolProvider::Codex, &hub.token.clone(), json!({ "model": "gpt-5" })).await;
    assert_eq!(response.status(), 503);
    let error = json!({ "message": "Account Pooler has no enabled account", "type": "api_error", "code": null });
    assert_eq!(json_body(response).await, json!({ "error": error }));

    let id = hub.add(PoolProvider::Claude, UUID_A, 0, key("a")).await;
    let mut quota = hub.state.quota(&id);
    quota.held_until = Some(now_ms() + 89_500);
    hub.state.set_quota(&id, Some(quota));
    let response = hub.message("s1").await;
    assert_eq!(response.status(), 429);
    assert_eq!(response.headers()["retry-after"], "90");
    let body = json_body(response).await;
    assert_eq!(body["error"]["type"], "rate_limit_error");
    assert_eq!(body["error"]["message"], "No Account Pooler account is currently eligible.");
}

#[tokio::test(start_paused = true)]
async fn polls_usage_every_five_minutes() {
    let hub = harness(ok()).await;
    hub.add(PoolProvider::Claude, UUID_A, 0, oauth("access-1", 3_600_000)).await;
    let stop = CancellationToken::new();
    let poller = tokio::spawn({
        let hub = hub.hub.clone();
        let stop = stop.clone();
        async move { hub.start(stop).await }
    });
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(hub.http.usage.load(Ordering::SeqCst), 1);
    tokio::time::sleep(Duration::from_secs(4 * 60)).await;
    assert_eq!(hub.http.usage.load(Ordering::SeqCst), 1);
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(hub.http.usage.load(Ordering::SeqCst), 2);
    stop.cancel();
    poller.await.expect("poller");
    assert_eq!(hub.http.refreshes.load(Ordering::SeqCst), 0);
}
