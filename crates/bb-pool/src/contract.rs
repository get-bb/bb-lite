use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

pub const ACCOUNTS_CHANGED: &str = "accounts-changed";
pub const HUB_PATH: &str = "/api/v1/plugins/account-pool/http";

pub const RPC_STATUS: &str = "status";
pub const RPC_ACCOUNT_ADD: &str = "account.add";
pub const RPC_ACCOUNT_UPDATE: &str = "account.update";
pub const RPC_ACCOUNT_REFRESH: &str = "account.refresh";
pub const RPC_ROUTING_SET: &str = "routing.set";
pub const RPC_CONFIG_SET: &str = "config.set";
pub const RPC_LOGIN_START: &str = "login.start";
pub const RPC_LOGIN_COMPLETE: &str = "login.complete";
pub const RPC_LOGIN_POLL: &str = "login.poll";
pub const POOL_RPC_METHODS: [&str; 9] = [
    RPC_STATUS,
    RPC_ACCOUNT_ADD,
    RPC_ACCOUNT_UPDATE,
    RPC_ACCOUNT_REFRESH,
    RPC_ROUTING_SET,
    RPC_CONFIG_SET,
    RPC_LOGIN_START,
    RPC_LOGIN_COMPLETE,
    RPC_LOGIN_POLL,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PoolProvider {
    Claude,
    Codex,
}

impl PoolProvider {
    pub const ALL: [PoolProvider; 2] = [PoolProvider::Claude, PoolProvider::Codex];

    pub fn as_str(self) -> &'static str {
        match self {
            PoolProvider::Claude => "claude",
            PoolProvider::Codex => "codex",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelFamily {
    Fable,
    Sonnet,
    Opus,
    Haiku,
    Other,
}

pub const FAMILIES: [ModelFamily; 5] = [
    ModelFamily::Fable,
    ModelFamily::Sonnet,
    ModelFamily::Opus,
    ModelFamily::Haiku,
    ModelFamily::Other,
];

impl ModelFamily {
    pub fn as_str(self) -> &'static str {
        match self {
            ModelFamily::Fable => "fable",
            ModelFamily::Sonnet => "sonnet",
            ModelFamily::Opus => "opus",
            ModelFamily::Haiku => "haiku",
            ModelFamily::Other => "other",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ValidationError(pub String);

fn check(ok: bool, path: &str, message: &str) -> Result<(), ValidationError> {
    if ok { Ok(()) } else { Err(ValidationError(format!("{path}: {message}"))) }
}

static UUID_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
    )
    .expect("uuid pattern")
});
static EMAIL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9_'+\-.]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$")
        .expect("email pattern")
});

/// zod `z.uuid()`: RFC 9562 versions 1-8 with the variant bits set, or the nil and max UUIDs.
pub fn is_uuid(value: &str) -> bool {
    UUID_RE.is_match(value)
}

/// zod `z.email()` default pattern.
pub fn is_email(value: &str) -> bool {
    !value.starts_with('.') && !value.contains("..") && EMAIL_RE.is_match(value)
}

pub fn is_url(value: &str) -> bool {
    url::Url::parse(value).is_ok()
}

pub fn is_http_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}

pub fn is_switch_threshold(value: f64) -> bool {
    value > 0.0 && value <= 1.0
}

fn non_empty(value: &str) -> bool {
    !value.is_empty()
}

fn default_anthropic() -> String {
    "https://api.anthropic.com".into()
}
fn default_codex() -> String {
    "https://chatgpt.com/backend-api/codex".into()
}
fn default_claude_token() -> String {
    "https://platform.claude.com/v1/oauth/token".into()
}
fn default_codex_auth() -> String {
    "https://auth.openai.com".into()
}
fn default_threshold() -> f64 {
    0.98
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolConfig {
    #[serde(default = "default_anthropic")]
    pub anthropic_upstream_base_url: String,
    #[serde(default = "default_codex")]
    pub codex_upstream_base_url: String,
    #[serde(default = "default_claude_token")]
    pub claude_token_url: String,
    #[serde(default = "default_codex_auth")]
    pub codex_auth_base_url: String,
    #[serde(default = "default_threshold")]
    pub switch_threshold: f64,
}

impl Default for PoolConfig {
    fn default() -> Self {
        PoolConfig {
            anthropic_upstream_base_url: default_anthropic(),
            codex_upstream_base_url: default_codex(),
            claude_token_url: default_claude_token(),
            codex_auth_base_url: default_codex_auth(),
            switch_threshold: default_threshold(),
        }
    }
}

impl PoolConfig {
    pub fn validate(&self) -> Result<(), ValidationError> {
        let urls = [
            ("anthropicUpstreamBaseUrl", &self.anthropic_upstream_base_url),
            ("codexUpstreamBaseUrl", &self.codex_upstream_base_url),
            ("claudeTokenUrl", &self.claude_token_url),
            ("codexAuthBaseUrl", &self.codex_auth_base_url),
        ];
        for (path, value) in urls {
            check(is_http_url(value), path, "Invalid URL")?;
        }
        check(is_switch_threshold(self.switch_threshold), "switchThreshold", "Out of range")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AccountKind {
    #[serde(rename = "oauth")]
    OAuth,
    #[serde(rename = "api-key")]
    ApiKey,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub provider: PoolProvider,
    pub kind: AccountKind,
    pub label: String,
    pub email: Option<String>,
    #[serde(default)]
    pub account_uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_account_id: Option<String>,
    pub subscription_type: Option<String>,
    pub rate_limit_tier: Option<String>,
    pub enabled: bool,
    pub priority: i64,
    pub created_at: i64,
    #[serde(default)]
    pub last_used_at: Option<i64>,
    #[serde(default)]
    pub last_used_host_id: Option<String>,
}

impl Account {
    pub fn validate(&self) -> Result<(), ValidationError> {
        check(is_uuid(&self.id), "id", "Invalid UUID")?;
        check(non_empty(&self.label), "label", "Too small")?;
        check(self.email.as_deref().is_none_or(is_email), "email", "Invalid email address")?;
        check(self.account_uuid.as_deref().is_none_or(is_uuid), "accountUuid", "Invalid UUID")?;
        check(
            self.codex_account_id.as_deref().is_none_or(non_empty),
            "codexAccountId",
            "Too small",
        )?;
        check(self.created_at >= 0, "createdAt", "Too small")?;
        check(self.last_used_at.is_none_or(|at| at >= 0), "lastUsedAt", "Too small")?;
        check(
            self.last_used_host_id.as_deref().is_none_or(non_empty),
            "lastUsedHostId",
            "Too small",
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    pub key: String,
    pub minutes: Option<i64>,
    pub utilization: Option<f64>,
    pub reset_at: Option<i64>,
    pub status: Option<String>,
}

impl LimitWindow {
    pub fn validate(&self) -> Result<(), ValidationError> {
        check(self.minutes.is_none_or(|minutes| minutes > 0), "minutes", "Too small")
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountQuota {
    pub windows: Vec<LimitWindow>,
    pub extra_usage: Option<bool>,
    pub observed_at: Option<i64>,
    pub held_until: Option<i64>,
    pub error: Option<String>,
}

impl AccountQuota {
    pub fn validate(&self) -> Result<(), ValidationError> {
        self.windows.iter().try_for_each(LimitWindow::validate)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccountStatus {
    Disabled,
    Ready,
    Held,
    Exhausted,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    #[serde(flatten)]
    pub account: Account,
    #[serde(flatten)]
    pub quota: AccountQuota,
    pub in_flight: u64,
    pub status: AccountStatus,
    pub blocked_until: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolHost {
    pub host_id: String,
    pub host_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Routing {
    pub claude: bool,
    pub codex: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolStatus {
    pub route: String,
    pub hosts: Vec<PoolHost>,
    pub accounts: Vec<AccountSummary>,
    pub routing: Routing,
    pub config: PoolConfig,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountAddInput {
    pub provider: PoolProvider,
    pub api_key: Option<String>,
    pub label: Option<String>,
    pub priority: i64,
}

impl AccountAddInput {
    pub fn validate(&self) -> Result<(), ValidationError> {
        check(self.api_key.as_deref().is_none_or(non_empty), "apiKey", "Too small")?;
        check(self.label.as_deref().is_none_or(non_empty), "label", "Too small")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginDevice {
    pub user_code: String,
    pub interval_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStart {
    pub session_id: String,
    pub url: String,
    pub expires_at: i64,
    pub device: Option<LoginDevice>,
}

impl LoginStart {
    pub fn validate(&self) -> Result<(), ValidationError> {
        check(is_uuid(&self.session_id), "sessionId", "Invalid UUID")?;
        check(is_url(&self.url), "url", "Invalid URL")?;
        check(self.expires_at >= 0, "expiresAt", "Too small")?;
        if let Some(device) = &self.device {
            check(non_empty(&device.user_code), "device.userCode", "Too small")?;
            check(device.interval_ms > 0, "device.intervalMs", "Too small")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum LoginPoll {
    Pending,
    Complete { account: Box<Account> },
    Error { message: String },
}

impl LoginPoll {
    pub fn validate(&self) -> Result<(), ValidationError> {
        match self {
            LoginPoll::Pending => Ok(()),
            LoginPoll::Complete { account } => account.validate(),
            LoginPoll::Error { message } => check(non_empty(message), "message", "Too small"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderInput {
    pub provider: PoolProvider,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AccountIdInput {
    pub id: String,
}

impl AccountIdInput {
    pub fn validate(&self) -> Result<(), ValidationError> {
        check(is_uuid(&self.id), "id", "Invalid UUID")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AccountUpdateInput {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<i64>,
}

impl AccountUpdateInput {
    pub fn validate(&self) -> Result<(), ValidationError> {
        check(is_uuid(&self.id), "id", "Invalid UUID")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoutingSetInput {
    pub provider: PoolProvider,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSetInput {
    pub switch_threshold: f64,
}

impl ConfigSetInput {
    pub fn validate(&self) -> Result<(), ValidationError> {
        check(is_switch_threshold(self.switch_threshold), "switchThreshold", "Out of range")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInput {
    pub session_id: String,
}

impl SessionInput {
    pub fn validate(&self) -> Result<(), ValidationError> {
        check(is_uuid(&self.session_id), "sessionId", "Invalid UUID")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginCompleteInput {
    pub session_id: String,
    pub code: String,
}

impl LoginCompleteInput {
    /// Trims `code` in place (zod `.trim()` transforms the value) before checking it.
    pub fn validate(&mut self) -> Result<(), ValidationError> {
        check(is_uuid(&self.session_id), "sessionId", "Invalid UUID")?;
        self.code = self.code.trim().to_string();
        check(non_empty(&self.code), "code", "Too small")
    }
}
