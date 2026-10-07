use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LoginState {
    Pending,
    SignedIn,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginView {
    pub state: LoginState,
    pub user_code: String,
    pub verification_url: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectState {
    Disconnected,
    Connected,
    Reconnecting,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareView {
    pub port: u16,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectStatus {
    pub state: ConnectState,
    pub paired: bool,
    pub enabled: bool,
    pub handle: Option<String>,
    pub url: Option<String>,
    pub last_error: Option<String>,
    pub next_retry_at: Option<u64>,
    pub login: Option<LoginView>,
    pub shares: Vec<ShareView>,
}

/// Input of `unexpose`. `port` is any JSON number, as in the zod contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortInput {
    pub port: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetEnabledInput {
    pub enabled: bool,
}

/// The RPC methods of the plugin; `status`, `login` and `logout` take `null`, every method
/// returns a [`ConnectStatus`].
pub const CONNECT_RPC_METHODS: [&str; 5] = ["status", "login", "logout", "setEnabled", "unexpose"];
