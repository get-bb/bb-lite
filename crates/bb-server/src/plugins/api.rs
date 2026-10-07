//! The plugin contract: what a plugin registers with the server and what the
//! server offers it. The Rust form of `PluginServerApi` in
//! `packages/plugin/src/server-api.ts`. Native plugins implement these traits
//! directly; TypeScript plugins running in QuickJS are adapted to them by
//! `plugins::js`.

use std::sync::Arc;

use async_trait::async_trait;
use axum::extract::Request;
use axum::response::Response;
use futures::future::BoxFuture;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::error::ApiResult;

#[derive(Clone, Debug, thiserror::Error)]
#[error("{message}")]
pub struct PluginError {
    pub message: String,
}

impl PluginError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }
}

impl From<crate::error::ApiError> for PluginError {
    fn from(error: crate::error::ApiError) -> Self {
        Self::new(error.to_string())
    }
}

pub type PluginResult<T> = Result<T, PluginError>;

/// What every per-thread plugin query carries.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadContext {
    pub thread_id: String,
    pub project_id: String,
    pub host_id: Option<String>,
    pub provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_capabilities: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SettingDescriptor {
    String {
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        secret: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        multiline: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default: Option<String>,
    },
    Boolean {
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default: Option<bool>,
    },
}

impl SettingDescriptor {
    pub fn is_secret(&self) -> bool {
        matches!(self, Self::String { secret: Some(true), .. })
    }

    pub fn default_value(&self) -> Option<Value> {
        match self {
            Self::String { default, .. } => default.clone().map(Value::String),
            Self::Boolean { default, .. } => default.map(Value::Bool),
        }
    }

    /// The value when it has this setting's type, as the TypeScript `accepted`.
    pub fn accept(&self, value: &Value) -> Option<Value> {
        match (self, value) {
            (Self::String { .. }, Value::String(_)) | (Self::Boolean { .. }, Value::Bool(_)) => {
                Some(value.clone())
            }
            _ => None,
        }
    }
}

pub type SettingDescriptors = IndexMap<String, SettingDescriptor>;
/// Setting values by key; a key that is absent has no value and no default.
pub type SettingRecord = IndexMap<String, Value>;
pub type SettingsListener = Arc<dyn Fn(&SettingRecord, &SettingRecord) + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RpcErrorCode {
    InvalidJson,
    InvalidInput,
    InvalidOutput,
    HandlerError,
    UnknownMethod,
    PluginUnavailable,
}

/// The `RpcError` body of `packages/plugin/src/rpc.ts`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RpcFailure {
    pub code: RpcErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issues: Option<Value>,
}

impl RpcFailure {
    pub fn handler(message: impl Into<String>) -> Self {
        Self { code: RpcErrorCode::HandlerError, message: message.into(), issues: None }
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self { code: RpcErrorCode::InvalidInput, message: message.into(), issues: None }
    }
}

/// One RPC method. It validates its own input and output against the
/// plugin's contract and reports a mismatch as `invalid_input` or
/// `invalid_output`.
#[async_trait]
pub trait RpcHandler: Send + Sync {
    async fn call(&self, input: Value) -> Result<Value, RpcFailure>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum HttpAuth {
    /// Only the owner.
    #[default]
    Local,
    /// Any admitted caller that presents the plugin token.
    Token,
    /// No check beyond the server's trust guard.
    None,
}

#[async_trait]
pub trait HttpHandler: Send + Sync {
    async fn handle(&self, request: Request) -> Response;
}

#[derive(Clone, Debug, Default)]
pub struct CliContext {
    pub cwd: Option<String>,
    pub thread_id: Option<String>,
    pub project_id: Option<String>,
    pub cancel: CancellationToken,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliResult {
    pub exit_code: i32,
    #[serde(default)]
    pub stdout: String,
    #[serde(default)]
    pub stderr: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CliCommandSummary {
    pub name: String,
    pub summary: String,
}

/// A plugin's `bb <name> ...` command, parsed and run in the server.
#[async_trait]
pub trait PluginCli: Send + Sync {
    fn name(&self) -> String;
    fn summary(&self) -> String;
    fn commands(&self) -> Vec<CliCommandSummary>;
    async fn run(&self, argv: Vec<String>, context: CliContext) -> CliResult;
}

#[derive(Clone, Debug, PartialEq)]
pub enum AgentToolResult {
    Text(String),
    Detailed { text: String, is_error: bool },
}

#[derive(Clone, Debug, PartialEq)]
pub enum ToolFailure {
    /// The arguments did not match the tool's schema; the text is the validator's message.
    InvalidArguments(String),
    /// The tool threw.
    Failed(String),
}

#[async_trait]
pub trait AgentTool: Send + Sync {
    fn name(&self) -> String;
    fn description(&self) -> String;
    fn instructions(&self) -> Option<String> {
        None
    }
    /// A `ThreadEventItemPresentation` as JSON.
    fn presentation(&self) -> Option<Value> {
        None
    }
    /// The JSON Schema of the tool's parameters.
    fn input_schema(&self) -> Value;
    async fn enabled_for(&self, _context: &ThreadContext) -> bool {
        true
    }
    async fn execute(
        &self,
        input: Value,
        context: ThreadContext,
        cancel: CancellationToken,
    ) -> Result<AgentToolResult, ToolFailure>;
}

pub type InstructionsContributor =
    Arc<dyn Fn(ThreadContext) -> BoxFuture<'static, PluginResult<Option<String>>> + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EnvValue {
    Literal(String),
    /// A path on this server; the engine turns it into a full URL for the session.
    #[serde(rename_all = "camelCase")]
    ServerPath {
        server_path: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderEnvEntry {
    pub name: String,
    pub value: EnvValue,
}

pub type EnvContributor = Arc<
    dyn Fn(ThreadContext) -> BoxFuture<'static, PluginResult<Vec<ProviderEnvEntry>>> + Send + Sync,
>;

/// Receives one plugin event payload (`PluginEvents` in the TypeScript API) as JSON.
pub type EventListener = Arc<dyn Fn(Value) -> BoxFuture<'static, PluginResult<()>> + Send + Sync>;

pub const PLUGIN_EVENT_NAMES: [&str; 8] = [
    "thread.created",
    "thread.active",
    "thread.idle",
    "thread.failed",
    "thread.archived",
    "thread.unarchived",
    "thread.deleted",
    "interaction.pending",
];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionQuery {
    pub trigger: String,
    pub query: String,
    pub project_id: Option<String>,
    pub thread_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MentionItem {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[async_trait]
pub trait MentionProvider: Send + Sync {
    fn id(&self) -> String;
    fn label(&self) -> String;
    fn triggers(&self) -> Vec<String> {
        vec!["@".to_owned()]
    }
    async fn search(&self, query: MentionQuery) -> PluginResult<Vec<MentionItem>>;
    /// The context text for one item.
    async fn resolve(&self, item_id: &str) -> PluginResult<String>;
}

#[async_trait]
pub trait InferenceService: Send + Sync {
    fn id(&self) -> String;
    fn display_name(&self) -> String;
    async fn complete(&self, prompt: &str, cancel: CancellationToken) -> PluginResult<String>;
}

/// Accepted by the plugin API; nothing in the server reads it yet.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentDefinition {
    pub id: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineAccess {
    pub server_url: String,
    pub headers: IndexMap<String, String>,
}

#[async_trait]
pub trait MachineAccessProvider: Send + Sync {
    async fn grant(&self, host_id: &str) -> PluginResult<Option<MachineAccess>>;
    async fn revoke(&self, host_id: &str, connect_machine_id: Option<&str>) -> PluginResult<()>;
}

/// A long-running task the host supervises: restarted with backoff when it
/// fails, cancelled through the token when the plugin unloads.
pub type BackgroundService =
    Arc<dyn Fn(CancellationToken) -> BoxFuture<'static, PluginResult<()>> + Send + Sync>;

pub type Disposer = Box<dyn FnOnce() -> BoxFuture<'static, ()> + Send>;

/// Title and detail for the timeline row of a submitted plugin interaction.
pub type DescribeSubmission = Arc<dyn Fn(Value) -> BoxFuture<'static, Option<Value>> + Send + Sync>;

#[derive(Clone)]
pub struct InputRequest {
    pub thread_id: String,
    pub renderer_id: String,
    pub title: String,
    pub payload: Value,
    pub timeout_ms: Option<u64>,
    pub cancel: Option<CancellationToken>,
    pub presentation: Option<Value>,
    pub describe_submission: Option<DescribeSubmission>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "lowercase")]
pub enum InputResult {
    Submitted { value: Value },
    Cancelled { reason: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReadArgs {
    pub thread_id: String,
    pub path: String,
    /// `"utf8"` (the default) or `"base64"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteArgs {
    pub thread_id: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
    pub content: String,
    /// Absent: no check. `Some(None)`: the file must not exist yet.
    #[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]
    pub expected_sha256: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
}

mod double_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(
        value: &Option<Option<String>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        value.as_ref().and_then(Option::as_ref).serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Option<String>>, D::Error> {
        Option::<String>::deserialize(deserializer).map(Some)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileRead {
    pub content: String,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "lowercase")]
pub enum FileWriteOutcome {
    Written { sha256: String },
    Conflict,
}

/// What a plugin may ask of the server, already attributed to the calling
/// plugin. Requests and responses are the JSON of the matching HTTP routes
/// (`createThreadRequestSchema`, `ThreadResponse`, ...), so the QuickJS
/// bridge passes them through and native plugins decode what they need.
#[async_trait]
pub trait PluginOutward: Send + Sync {
    async fn threads_spawn(&self, request: Value) -> ApiResult<Value>;
    async fn threads_send(&self, thread_id: &str, request: Value) -> ApiResult<Value>;
    async fn threads_get(&self, thread_id: &str) -> ApiResult<Option<Value>>;
    async fn threads_list(&self, query: Value) -> ApiResult<Value>;
    async fn threads_stop(&self, thread_id: &str) -> ApiResult<()>;
    async fn threads_update(&self, thread_id: &str, patch: Value) -> ApiResult<Value>;
    async fn threads_output(&self, thread_id: &str) -> ApiResult<Option<String>>;
    async fn threads_events(
        &self,
        thread_id: &str,
        after_sequence: Option<i64>,
    ) -> ApiResult<Vec<Value>>;
    async fn projects_list(&self) -> ApiResult<Value>;
    async fn hosts_list(&self) -> ApiResult<Value>;
    async fn sections_list(&self) -> ApiResult<Value>;
    async fn sections_create(&self, name: &str) -> ApiResult<Value>;
    async fn files_read(&self, args: FileReadArgs) -> ApiResult<Option<FileRead>>;
    async fn files_write(&self, args: FileWriteArgs) -> ApiResult<FileWriteOutcome>;
    async fn request_input(&self, request: InputRequest) -> InputResult;
}

/// Builds the outward API for one plugin id.
pub type PluginHostDeps = Arc<dyn Fn(&str) -> Arc<dyn PluginOutward> + Send + Sync>;

/// A plugin written in Rust and compiled into the server. `start` is the
/// plugin entry function: it registers everything through `api` and returns.
#[async_trait]
pub trait NativePlugin: Send + Sync {
    async fn start(&self, api: crate::plugins::instance::PluginApi) -> PluginResult<()>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shapes_match_the_typescript_api() {
        let descriptor: SettingDescriptor =
            serde_json::from_value(json!({"type": "string", "label": "Token", "secret": true}))
                .unwrap();
        assert!(descriptor.is_secret());
        assert_eq!(descriptor.accept(&json!(true)), None);
        let entry = ProviderEnvEntry {
            name: "A".into(),
            value: EnvValue::ServerPath { server_path: "/x".into() },
        };
        assert_eq!(
            serde_json::to_value(&entry).unwrap(),
            json!({"name": "A", "value": {"serverPath": "/x"}})
        );
        let literal: ProviderEnvEntry =
            serde_json::from_value(json!({"name": "B", "value": "v"})).unwrap();
        assert_eq!(literal.value, EnvValue::Literal("v".into()));
        let cancelled = InputResult::Cancelled { reason: "timeout".into() };
        assert_eq!(
            serde_json::to_value(&cancelled).unwrap(),
            json!({"outcome": "cancelled", "reason": "timeout"})
        );
        let write: FileWriteArgs = serde_json::from_value(
            json!({"threadId": "t", "path": "a", "content": "", "expectedSha256": null}),
        )
        .unwrap();
        assert_eq!(write.expected_sha256, Some(None));
        let unchecked: FileWriteArgs =
            serde_json::from_value(json!({"threadId": "t", "path": "a", "content": ""})).unwrap();
        assert_eq!(unchecked.expected_sha256, None);
    }
}
