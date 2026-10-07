use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bytes::Bytes;
use http::{Method, Request, Response, StatusCode, header};
use parking_lot::Mutex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::contract::{
    Account, AccountKind, LoginDevice, LoginPoll, LoginStart, PoolConfig, PoolProvider, is_email,
    is_uuid,
};
use crate::limits::{dig, epoch_ms, js_number, parse_date, retry_after_ms};
use crate::store::{AccountSecret, NewAccount, now_ms, random_uuid};

pub const CLAUDE_OAUTH_BETA: &str = "oauth-2025-04-20";
pub const CLAUDE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
pub const CLAUDE_AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
pub const CLAUDE_REDIRECT_URI: &str = "https://console.anthropic.com/oauth/code/callback";
pub const CLAUDE_SCOPES: &str = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
pub const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const CHATGPT_AUTH_CLAIM: &str = "https://api.openai.com/auth";
pub const CHATGPT_PROFILE_CLAIM: &str = "https://api.openai.com/profile";
pub const LOGIN_TTL_MS: i64 = 10 * 60 * 1_000;
pub const REFRESH_TIMEOUT_MS: u64 = 15_000;

/// The HTTP transport for every OAuth call, injected so the caller can route through a proxy.
#[async_trait]
pub trait HttpClient: Send + Sync {
    async fn send(&self, request: Request<Bytes>) -> Result<Response<Bytes>, String>;
}

/// `HttpClient` over reqwest, which honours `HTTP(S)_PROXY`/`NO_PROXY` from the environment.
#[derive(Debug, Clone)]
pub struct ReqwestClient {
    client: reqwest::Client,
}

impl ReqwestClient {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(Self { client: reqwest::Client::builder().build()? })
    }

    pub fn from_client(client: reqwest::Client) -> Self {
        Self { client }
    }
}

#[async_trait]
impl HttpClient for ReqwestClient {
    async fn send(&self, request: Request<Bytes>) -> Result<Response<Bytes>, String> {
        let request = reqwest::Request::try_from(request).map_err(|error| error.to_string())?;
        let response = self.client.execute(request).await.map_err(|error| error.to_string())?;
        let status = response.status();
        let headers = response.headers().clone();
        let body = response.bytes().await.map_err(|error| error.to_string())?;
        let mut out = Response::new(body);
        *out.status_mut() = status;
        *out.headers_mut() = headers;
        Ok(out)
    }
}

/// The `kind: "oauth"` arm of `AccountSecret`.
#[derive(Debug, Clone, PartialEq)]
pub struct OAuthSecret {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: Option<i64>,
    pub id_token: Option<String>,
}

impl OAuthSecret {
    pub fn from_secret(secret: &AccountSecret) -> Option<Self> {
        match secret {
            AccountSecret::OAuth { access_token, refresh_token, expires_at, id_token } => {
                Some(Self {
                    access_token: access_token.clone(),
                    refresh_token: refresh_token.clone(),
                    expires_at: *expires_at,
                    id_token: id_token.clone(),
                })
            }
            AccountSecret::ApiKey { .. } => None,
        }
    }
}

impl From<OAuthSecret> for AccountSecret {
    fn from(secret: OAuthSecret) -> Self {
        AccountSecret::OAuth {
            access_token: secret.access_token,
            refresh_token: secret.refresh_token,
            expires_at: secret.expires_at,
            id_token: secret.id_token,
        }
    }
}

/// `NewAccount` without `kind`, `enabled` and `priority`, plus the OAuth secret.
#[derive(Debug, Clone, PartialEq)]
pub struct AccountDraft {
    pub provider: PoolProvider,
    pub label: String,
    pub email: Option<String>,
    pub account_uuid: Option<String>,
    pub codex_account_id: Option<String>,
    pub subscription_type: Option<String>,
    pub rate_limit_tier: Option<String>,
    pub secret: OAuthSecret,
}

impl AccountDraft {
    /// The store input `server.ts`'s `adopt` builds: `kind: "oauth"`, enabled, label overridable.
    pub fn new_account(&self, label: Option<String>, priority: i64) -> NewAccount {
        NewAccount {
            provider: self.provider,
            kind: AccountKind::OAuth,
            label: label.unwrap_or_else(|| self.label.clone()),
            email: self.email.clone(),
            account_uuid: self.account_uuid.clone(),
            codex_account_id: self.codex_account_id.clone(),
            subscription_type: self.subscription_type.clone(),
            rate_limit_tier: self.rate_limit_tier.clone(),
            enabled: true,
            priority,
        }
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("OAuth refresh {reason}.")]
pub struct TransientRefreshError {
    pub reason: String,
    pub retry_after_ms: i64,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum OAuthError {
    #[error(transparent)]
    Transient(#[from] TransientRefreshError),
    #[error("{0}")]
    Failed(String),
}

fn failed(message: impl Into<String>) -> OAuthError {
    OAuthError::Failed(message.into())
}

fn text(value: &Value, keys: &[&str]) -> Option<String> {
    let found = dig(value, keys)?.as_str()?.trim();
    (!found.is_empty()).then(|| found.to_owned())
}

fn email(value: &Value, keys: &[&str]) -> Option<String> {
    text(value, keys).filter(|found| is_email(found))
}

fn positive(value: &Value, key: &str) -> Option<f64> {
    dig(value, &[key])?.as_f64().filter(|found| *found > 0.0)
}

fn uuid(value: Option<&Value>) -> Option<String> {
    value?.as_str().filter(|found| is_uuid(found)).map(str::to_owned)
}

fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(found)) => !found.is_empty(),
        Some(_) => true,
    }
}

fn js_number_value(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(found)) => js_number(found).unwrap_or(f64::NAN),
        Some(_) => f64::NAN,
    }
}

/// The base64url S256 PKCE challenge for `verifier`.
pub fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn random_base64url() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}

/// The payload of a JWT, unverified; `Value::Null` when it does not decode.
pub fn jwt_claims(token: Option<&str>) -> Value {
    let payload = token.and_then(|token| token.split('.').nth(1)).unwrap_or("");
    let normalized: String = payload
        .chars()
        .filter(|c| *c != '=')
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            other => other,
        })
        .collect();
    URL_SAFE_NO_PAD
        .decode(normalized)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

/// The `exp` claim of a JWT in epoch milliseconds.
pub fn jwt_expiry(token: &str) -> Option<i64> {
    positive(&jwt_claims(Some(token)), "exp").map(|expiry| js_round(expiry * 1_000.0))
}

pub fn codex_draft(
    access_token: &str,
    refresh_token: &str,
    id_token: Option<&str>,
    account_id: Option<String>,
) -> Result<AccountDraft, OAuthError> {
    let (id, access) = (jwt_claims(id_token), jwt_claims(Some(access_token)));
    let account = [CHATGPT_AUTH_CLAIM, "chatgpt_account_id"];
    let codex_account_id = account_id
        .or_else(|| text(&id, &account))
        .or_else(|| text(&id, &["chatgpt_account_id"]))
        .or_else(|| text(&access, &account))
        .ok_or_else(|| failed("Codex tokens do not include a ChatGPT account id."))?;
    let address = email(&id, &["email"])
        .or_else(|| email(&id, &[CHATGPT_PROFILE_CLAIM, "email"]))
        .or_else(|| email(&access, &["email"]))
        .or_else(|| email(&access, &[CHATGPT_PROFILE_CLAIM, "email"]));
    Ok(AccountDraft {
        provider: PoolProvider::Codex,
        label: address.clone().unwrap_or_else(|| "Codex account".into()),
        email: address,
        account_uuid: None,
        codex_account_id: Some(codex_account_id),
        subscription_type: None,
        rate_limit_tier: None,
        secret: OAuthSecret {
            access_token: access_token.to_owned(),
            refresh_token: refresh_token.to_owned(),
            expires_at: jwt_expiry(access_token),
            id_token: id_token.map(str::to_owned),
        },
    })
}

/// `os.homedir()`: `$HOME`, or the current directory when it is unset.
pub fn default_home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

async fn home_json(home: &Path, segments: &[&str]) -> Value {
    let file = segments.iter().fold(home.to_path_buf(), |path, segment| path.join(segment));
    match tokio::fs::read_to_string(file).await {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

/// Reads the Claude Code (`~/.claude/.credentials.json`, `~/.claude.json`) or Codex
/// (`~/.codex/auth.json`) CLI login under `home`.
pub async fn import_account(
    provider: PoolProvider,
    home: &Path,
) -> Result<AccountDraft, OAuthError> {
    let codex = provider == PoolProvider::Codex;
    let file: &[&str] =
        if codex { &[".codex", "auth.json"] } else { &[".claude", ".credentials.json"] };
    let root = home_json(home, file).await;
    let tokens = dig(&root, &[if codex { "tokens" } else { "claudeAiOauth" }])
        .cloned()
        .unwrap_or(Value::Null);
    let access_token = text(&tokens, &[if codex { "access_token" } else { "accessToken" }]);
    let refresh_token = text(&tokens, &[if codex { "refresh_token" } else { "refreshToken" }]);
    let (Some(access_token), Some(refresh_token)) = (access_token, refresh_token) else {
        let (name, command) =
            if codex { ("Codex", "codex login") } else { ("Claude Code", "claude /login") };
        let advice = format!("Run `{command}` on the bb server host, then retry.");
        return Err(failed(format!("{name} OAuth credentials were not found. {advice}")));
    };
    if codex {
        let id_token = text(&tokens, &["id_token"]);
        let account_id = text(&tokens, &["account_id"]);
        return codex_draft(&access_token, &refresh_token, id_token.as_deref(), account_id);
    }
    let profile = home_json(home, &[".claude.json"]).await;
    let owner = dig(&profile, &["oauthAccount"]).cloned().unwrap_or(Value::Null);
    let address = email(&owner, &["emailAddress"]);
    Ok(AccountDraft {
        provider: PoolProvider::Claude,
        label: address.clone().unwrap_or_else(|| "Claude Code account".into()),
        email: address,
        account_uuid: uuid(dig(&owner, &["accountUuid"])),
        codex_account_id: None,
        subscription_type: text(&tokens, &["subscriptionType"]),
        rate_limit_tier: text(&tokens, &["rateLimitTier"]),
        secret: OAuthSecret {
            access_token,
            refresh_token,
            expires_at: positive(&tokens, "expiresAt").map(js_round),
            id_token: None,
        },
    })
}

fn codex_auth_url(config: &PoolConfig, pathname: &str) -> String {
    format!("{}{pathname}", config.codex_auth_base_url.trim_end_matches('/'))
}

fn build_request(
    method: Method,
    url: &str,
    headers: &[(&str, &str)],
    body: Bytes,
) -> Result<Request<Bytes>, String> {
    let mut builder = Request::builder().method(method).uri(url);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(body).map_err(|error| error.to_string())
}

fn json_request(url: &str, body: &Value) -> Result<Request<Bytes>, String> {
    let headers = [("accept", "application/json"), ("content-type", "application/json")];
    build_request(Method::POST, url, &headers, Bytes::from(body.to_string()))
}

fn payload(response: &Response<Bytes>) -> Value {
    serde_json::from_slice(response.body()).unwrap_or(Value::Null)
}

/// Exchanges the refresh token. A network error, timeout, non-auth HTTP failure or unreadable
/// reply is `OAuthError::Transient`; HTTP 400/401 is `OAuthError::Failed`.
pub async fn refresh_oauth(
    provider: PoolProvider,
    secret: &OAuthSecret,
    config: &PoolConfig,
    client: &dyn HttpClient,
) -> Result<OAuthSecret, OAuthError> {
    let claude = provider == PoolProvider::Claude;
    let url = if claude {
        config.claude_token_url.clone()
    } else {
        codex_auth_url(config, "/oauth/token")
    };
    let body = json!({
        "grant_type": "refresh_token",
        "refresh_token": secret.refresh_token,
        "client_id": if claude { CLAUDE_CLIENT_ID } else { CODEX_CLIENT_ID },
    });
    let network = || TransientRefreshError {
        reason: "failed due to a network error or timeout".into(),
        retry_after_ms: 0,
    };
    let request = json_request(&url, &body).map_err(|_| network())?;
    let timeout = Duration::from_millis(REFRESH_TIMEOUT_MS);
    let response = match tokio::time::timeout(timeout, client.send(request)).await {
        Ok(Ok(response)) => response,
        _ => return Err(network().into()),
    };
    let status = response.status();
    if status == StatusCode::BAD_REQUEST || status == StatusCode::UNAUTHORIZED {
        return Err(failed(format!("OAuth refresh failed with HTTP {}.", status.as_u16())));
    }
    if !status.is_success() {
        let retry_after =
            response.headers().get(header::RETRY_AFTER).and_then(|value| value.to_str().ok());
        return Err(TransientRefreshError {
            reason: format!("failed with HTTP {}", status.as_u16()),
            retry_after_ms: retry_after_ms(retry_after, now_ms()),
        }
        .into());
    }
    let reply = payload(&response);
    let access_token = text(&reply, &["access_token"]).ok_or_else(|| TransientRefreshError {
        reason: "returned an unreadable response".into(),
        retry_after_ms: 0,
    })?;
    let lifetime = positive(&reply, "expires_in").unwrap_or(60.0 * 60.0) * 1_000.0;
    let expiry = positive(&reply, "expires_at").unwrap_or(now_ms() as f64 + lifetime);
    let id_token = text(&reply, &["id_token"]).or_else(|| secret.id_token.clone());
    Ok(OAuthSecret {
        expires_at: if claude { Some(epoch_ms(expiry)) } else { jwt_expiry(&access_token) },
        access_token,
        refresh_token: text(&reply, &["refresh_token"])
            .unwrap_or_else(|| secret.refresh_token.clone()),
        id_token,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualCode {
    pub code: String,
    pub state: String,
}

/// Reads a pasted Claude authorization: a callback URL, `code#state`, or a bare code.
pub fn parse_manual_code(pasted: &str, expected_state: &str) -> Result<ManualCode, OAuthError> {
    let trimmed = pasted.trim();
    let query = url::Url::parse(trimmed).ok().and_then(|parsed| {
        let find = |key: &str| {
            parsed.query_pairs().find(|(name, _)| name == key).map(|(_, value)| value.into_owned())
        };
        find("code").map(|code| (code, find("state").unwrap_or_default()))
    });
    let (code, state) = match query {
        Some(found) => found,
        None => match trimmed.split_once('#') {
            Some((code, state)) => (code.to_owned(), state.to_owned()),
            None => (trimmed.to_owned(), String::new()),
        },
    };
    let (code, state) = (code.trim(), state.trim());
    if code.is_empty() {
        return Err(failed("Paste the authorization code."));
    }
    if !state.is_empty() && state != expected_state {
        return Err(failed("OAuth state mismatch. Start again."));
    }
    Ok(ManualCode { code: code.to_owned(), state: expected_state.to_owned() })
}

pub type AddFuture = Pin<Box<dyn Future<Output = Result<Account, String>> + Send>>;
/// Adopts a finished login into the store; the error string is shown to the user.
pub type AddAccount = Arc<dyn Fn(AccountDraft) -> AddFuture + Send + Sync>;
pub type ConfigGetter = Arc<dyn Fn() -> PoolConfig + Send + Sync>;

#[derive(Clone)]
pub struct LoginDeps {
    pub client: Arc<dyn HttpClient>,
    pub config: ConfigGetter,
    pub add: AddAccount,
}

struct BrowserSession {
    session_id: String,
    verifier: String,
    state: String,
    expires_at: i64,
}

struct DeviceSession {
    device_auth_id: String,
    user_code: String,
    interval_ms: i64,
    expires_at: i64,
    next_poll_at: i64,
    polling: bool,
}

#[derive(Default)]
struct LoginState {
    browser: Option<BrowserSession>,
    devices: HashMap<String, DeviceSession>,
}

/// In-flight interactive logins: Claude PKCE with a pasted code, Codex device code with polling.
pub struct Logins {
    deps: LoginDeps,
    state: Mutex<LoginState>,
}

impl Logins {
    pub fn new(deps: LoginDeps) -> Self {
        Self { deps, state: Mutex::new(LoginState::default()) }
    }

    pub async fn start(&self, provider: PoolProvider) -> Result<LoginStart, OAuthError> {
        let session_id = random_uuid();
        let now = now_ms();
        if provider == PoolProvider::Claude {
            let verifier = random_base64url();
            let state = random_base64url();
            let expires_at = now + LOGIN_TTL_MS;
            let challenge = pkce_challenge(&verifier);
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("code", "true")
                .append_pair("client_id", CLAUDE_CLIENT_ID)
                .append_pair("response_type", "code")
                .append_pair("redirect_uri", CLAUDE_REDIRECT_URI)
                .append_pair("scope", CLAUDE_SCOPES)
                .append_pair("code_challenge", &challenge)
                .append_pair("code_challenge_method", "S256")
                .append_pair("state", &state)
                .finish();
            self.state.lock().browser = Some(BrowserSession {
                session_id: session_id.clone(),
                verifier,
                state,
                expires_at,
            });
            let url = format!("{CLAUDE_AUTHORIZE_URL}?{query}");
            return Ok(LoginStart { session_id, url, expires_at, device: None });
        }
        self.state.lock().devices.retain(|_, session| now < session.expires_at);
        let step = "Codex device login";
        let url = self.codex_url("/api/accounts/deviceauth/usercode");
        let request = json_request(&url, &json!({ "client_id": CODEX_CLIENT_ID }));
        let issued = self.request(step, request).await?;
        let device_auth_id = text(&issued, &["device_auth_id"]);
        let user_code = text(&issued, &["user_code"]);
        let interval = js_number_value(dig(&issued, &["interval"])) * 1_000.0;
        let (Some(device_auth_id), Some(user_code), true) =
            (device_auth_id, user_code, interval.is_finite() && js_round(interval) > 0)
        else {
            return Err(failed(format!("{step} returned an invalid response. Start again.")));
        };
        let interval_ms = js_round(interval);
        let lifetime = positive(&issued, "expires_in").unwrap_or(f64::INFINITY) * 1_000.0;
        let stated = text(&issued, &["expires_at"]).and_then(|found| parse_date(&found));
        let granted = stated.map_or(now as f64 + lifetime, |at| at as f64);
        let expires_at = ((now + LOGIN_TTL_MS) as f64).min(granted) as i64;
        self.state.lock().devices.insert(
            session_id.clone(),
            DeviceSession {
                device_auth_id,
                user_code: user_code.clone(),
                interval_ms,
                expires_at,
                next_poll_at: now + interval_ms,
                polling: false,
            },
        );
        let url = self.codex_url("/codex/device");
        Ok(LoginStart {
            session_id,
            url,
            expires_at,
            device: Some(LoginDevice { user_code, interval_ms }),
        })
    }

    pub async fn complete(&self, session_id: &str, pasted: &str) -> Result<Account, OAuthError> {
        let session = {
            let mut state = self.state.lock();
            match state.browser.take() {
                Some(session) if session.session_id == session_id => session,
                other => {
                    state.browser = other;
                    return Err(failed("Login session was not found. Start again."));
                }
            }
        };
        if now_ms() >= session.expires_at {
            return Err(failed("Code expired, start again."));
        }
        let config = (self.deps.config)();
        let exchange = "Claude token exchange";
        let manual = parse_manual_code(pasted, &session.state)?;
        let body = json!({
            "grant_type": "authorization_code",
            "code": manual.code,
            "state": manual.state,
            "code_verifier": session.verifier,
            "redirect_uri": CLAUDE_REDIRECT_URI,
            "client_id": CLAUDE_CLIENT_ID,
        });
        let tokens = self.request(exchange, json_request(&config.claude_token_url, &body)).await?;
        let access_token = text(&tokens, &["access_token"]);
        let refresh_token = text(&tokens, &["refresh_token"]);
        let lifetime = positive(&tokens, "expires_in");
        let (Some(access_token), Some(refresh_token), Some(lifetime)) =
            (access_token, refresh_token, lifetime)
        else {
            return Err(failed(format!("{exchange} returned an invalid response. Start again.")));
        };
        let authorization = format!("Bearer {access_token}");
        let profile_url = url::Url::parse(&config.anthropic_upstream_base_url)
            .and_then(|base| base.join("/api/oauth/profile"))
            .map_err(|_| failed("Invalid URL"))?;
        let headers =
            [("authorization", authorization.as_str()), ("anthropic-beta", CLAUDE_OAUTH_BETA)];
        let request = build_request(Method::GET, profile_url.as_str(), &headers, Bytes::new());
        let profile = self.request("Claude profile lookup", request).await?;
        let read = |keys: &[&str]| text(&profile, keys);
        let has = |plan: &str| truthy(dig(&profile, &["account", &format!("has_claude_{plan}")]));
        let plan = if has("pro") {
            Some("pro".to_owned())
        } else {
            read(&["account", "subscription_type"])
        };
        let address = email(&profile, &["account", "email"]);
        let expires_at = js_round(now_ms() as f64 + lifetime * 1_000.0);
        let draft = AccountDraft {
            provider: PoolProvider::Claude,
            label: read(&["account", "display_name"])
                .or_else(|| address.clone())
                .or_else(|| read(&["organization", "name"]))
                .unwrap_or_else(|| "Claude account".into()),
            email: address,
            account_uuid: read(&["account", "uuid"]).filter(|found| is_uuid(found)),
            codex_account_id: None,
            subscription_type: (if has("max") { Some("max".to_owned()) } else { plan })
                .or_else(|| read(&["organization", "organization_type"])),
            rate_limit_tier: read(&["account", "rate_limit_tier"])
                .or_else(|| read(&["organization", "rate_limit_tier"])),
            secret: OAuthSecret {
                access_token,
                refresh_token,
                expires_at: Some(expires_at),
                id_token: None,
            },
        };
        (self.deps.add)(draft).await.map_err(OAuthError::Failed)
    }

    pub async fn poll(&self, session_id: &str) -> LoginPoll {
        let fail = |message: &str| {
            self.state.lock().devices.remove(session_id);
            LoginPoll::Error { message: message.to_owned() }
        };
        let now = now_ms();
        let (device_auth_id, user_code) = {
            let mut state = self.state.lock();
            let Some(session) = state.devices.get_mut(session_id) else {
                drop(state);
                return fail("Login session was not found. Start again.");
            };
            if now >= session.expires_at {
                drop(state);
                return fail("Code expired, start again.");
            }
            if session.polling || now < session.next_poll_at {
                return LoginPoll::Pending;
            }
            session.polling = true;
            session.next_poll_at = now + session.interval_ms;
            (session.device_auth_id.clone(), session.user_code.clone())
        };
        let url = self.codex_url("/api/accounts/deviceauth/token");
        let body = json!({ "device_auth_id": device_auth_id, "user_code": user_code });
        let reply = match json_request(&url, &body) {
            Ok(request) => self.deps.client.send(request).await.ok(),
            Err(_) => None,
        };
        if let Some(session) = self.state.lock().devices.get_mut(session_id) {
            session.polling = false;
        }
        let Some(response) = reply else { return LoginPoll::Pending };
        let status = response.status();
        let payload = payload(&response);
        let code = text(&payload, &["error", "code"]).unwrap_or_default().to_lowercase();
        if code.contains("slow_down") {
            if let Some(session) = self.state.lock().devices.get_mut(session_id) {
                session.interval_ms += 5_000;
                session.next_poll_at = now_ms() + session.interval_ms;
            }
            return LoginPoll::Pending;
        }
        if code.contains("expired") {
            return fail("Code expired, start again.");
        }
        if code.contains("denied") || code.contains("declined") {
            return fail("Codex authorization was declined. Start again.");
        }
        let ok = status.is_success();
        let waiting = status == StatusCode::FORBIDDEN
            || status == StatusCode::NOT_FOUND
            || status.as_u16() >= 500;
        if !ok && waiting {
            return LoginPoll::Pending;
        }
        let grant = text(&payload, &["authorization_code"]);
        let verifier = text(&payload, &["code_verifier"]);
        let (true, Some(grant), Some(verifier)) = (ok, grant, verifier) else {
            let problem = if ok {
                "returned an invalid response".to_owned()
            } else {
                format!("failed (HTTP {})", status.as_u16())
            };
            return fail(&format!("Codex authorization {problem}. Start again."));
        };
        self.state.lock().devices.remove(session_id);
        match self.exchange_device_grant(&grant, &verifier).await {
            Ok(account) => LoginPoll::Complete { account: Box::new(account) },
            Err(error) => fail(&error.to_string()),
        }
    }

    async fn exchange_device_grant(
        &self,
        code: &str,
        verifier: &str,
    ) -> Result<Account, OAuthError> {
        let step = "Codex token exchange";
        let form = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "authorization_code")
            .append_pair("code", code)
            .append_pair("redirect_uri", &self.codex_url("/deviceauth/callback"))
            .append_pair("client_id", CODEX_CLIENT_ID)
            .append_pair("code_verifier", verifier)
            .finish();
        let headers =
            [("accept", "application/json"), ("content-type", "application/x-www-form-urlencoded")];
        let url = self.codex_url("/oauth/token");
        let request = build_request(Method::POST, &url, &headers, Bytes::from(form));
        let tokens = self.request(step, request).await?;
        let access_token = text(&tokens, &["access_token"]);
        let refresh_token = text(&tokens, &["refresh_token"]);
        let id_token = text(&tokens, &["id_token"]);
        let (Some(access_token), Some(refresh_token), Some(id_token)) =
            (access_token, refresh_token, id_token)
        else {
            return Err(failed(format!("{step} returned an invalid response. Start again.")));
        };
        let draft = codex_draft(&access_token, &refresh_token, Some(&id_token), None)?;
        (self.deps.add)(draft).await.map_err(OAuthError::Failed)
    }

    fn codex_url(&self, pathname: &str) -> String {
        codex_auth_url(&(self.deps.config)(), pathname)
    }

    async fn request(
        &self,
        step: &str,
        request: Result<Request<Bytes>, String>,
    ) -> Result<Value, OAuthError> {
        let response = self.deps.client.send(request.map_err(failed)?).await.map_err(failed)?;
        if response.status().is_success() {
            return Ok(payload(&response));
        }
        Err(failed(format!("{step} failed (HTTP {}). Start again.", response.status().as_u16())))
    }
}
