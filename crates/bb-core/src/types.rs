use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SERVER_URL_PLACEHOLDER: &str = "{BB_SERVER_URL}";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ProviderId {
    #[serde(rename = "codex")]
    Codex,
    #[serde(rename = "claude-code")]
    ClaudeCode,
    #[serde(rename = "echo")]
    Echo,
}

impl ProviderId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude-code",
            Self::Echo => "echo",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "codex" => Some(Self::Codex),
            "claude-code" => Some(Self::ClaudeCode),
            "echo" => Some(Self::Echo),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningLevel {
    None,
    Low,
    Medium,
    High,
    Xhigh,
    Ultracode,
    Max,
    Ultra,
}

pub const REASONING_LEVELS: [ReasoningLevel; 8] = [
    ReasoningLevel::None,
    ReasoningLevel::Low,
    ReasoningLevel::Medium,
    ReasoningLevel::High,
    ReasoningLevel::Xhigh,
    ReasoningLevel::Ultracode,
    ReasoningLevel::Max,
    ReasoningLevel::Ultra,
];

impl ReasoningLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Ultracode => "ultracode",
            Self::Max => "max",
            Self::Ultra => "ultra",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        REASONING_LEVELS.into_iter().find(|level| level.as_str() == text)
    }

    pub fn rank(self) -> usize {
        self as usize
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceTier {
    Fast,
    Default,
}

impl ServiceTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fast => "fast",
            Self::Default => "default",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "fast" => Some(Self::Fast),
            "default" => Some(Self::Default),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum PermissionMode {
    #[serde(rename = "accept-edits")]
    AcceptEdits,
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "full")]
    Full,
}

pub const PERMISSION_MODES: [PermissionMode; 3] =
    [PermissionMode::AcceptEdits, PermissionMode::Auto, PermissionMode::Full];

impl PermissionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AcceptEdits => "accept-edits",
            Self::Auto => "auto",
            Self::Full => "full",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        PERMISSION_MODES.into_iter().find(|mode| mode.as_str() == text)
    }

    pub fn parse_input(text: &str) -> Option<Self> {
        if text == "workspace-write" { Some(Self::AcceptEdits) } else { Self::parse(text) }
    }

    pub fn rank(self) -> usize {
        self as usize
    }

    pub fn clamp_to_ceiling(
        self,
        ceiling: PermissionMode,
        supported: Option<&[PermissionMode]>,
    ) -> Option<PermissionMode> {
        if self.rank() <= ceiling.rank() {
            return Some(self);
        }
        let supported = supported.unwrap_or(&PERMISSION_MODES);
        supported.iter().copied().filter(|mode| mode.rank() <= ceiling.rank()).max()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionEscalation {
    Ask,
    Deny,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionOptions {
    pub model: String,
    pub reasoning_level: ReasoningLevel,
    pub service_tier: ServiceTier,
    pub permission_mode: PermissionMode,
    pub permission_escalation: PermissionEscalation,
    #[serde(default)]
    pub provider_options: serde_json::Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicTool {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub input_schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Value>,
}

/// Environment changes for sessions that run `model`: a `customModels` entry of the server's
/// `config.json` that sets `env` or `unsetEnv`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomModelSettings {
    pub model: String,
    #[serde(default)]
    pub env: IndexMap<String, String>,
    #[serde(default)]
    pub unset_env: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSpec {
    pub thread_id: String,
    pub provider_id: ProviderId,
    pub cwd: String,
    pub provider_thread_id: Option<String>,
    pub instructions: String,
    #[serde(default)]
    pub dynamic_tools: Vec<DynamicTool>,
    #[serde(default)]
    pub env: IndexMap<String, String>,
    #[serde(default)]
    pub skill_dirs: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_models: Vec<CustomModelSettings>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SubmitTurnMode {
    Start,
    #[serde(rename_all = "camelCase")]
    Steer {
        expected_turn_id: String,
    },
    Auto,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitTurnArgs {
    pub session: SessionSpec,
    pub client_request_id: String,
    pub input: Vec<Value>,
    pub options: ExecutionOptions,
    pub mode: SubmitTurnMode,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum SubmitTurnResult {
    #[serde(rename_all = "camelCase")]
    Started { provider_thread_id: String },
    #[serde(rename_all = "camelCase")]
    Steered { provider_thread_id: String, turn_id: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerInfo {
    pub instance_id: String,
    pub version: String,
    pub host_name: String,
    pub platform: String,
    pub home_dir: String,
    pub data_dir: String,
    pub thread_storage_root: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub thread_id: String,
    pub provider_id: ProviderId,
    pub provider_thread_id: String,
    pub active_turn_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerSnapshot {
    pub sessions: Vec<SessionSnapshot>,
    pub pending_request_ids: Vec<String>,
    pub terminal_ids: Vec<String>,
    pub last_event_seq: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderAuth {
    Ready,
    Unauthenticated,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider_id: ProviderId,
    pub installed: bool,
    pub executable_path: Option<String>,
    pub version: Option<String>,
    pub auth: ProviderAuth,
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelReasoningEffort {
    pub reasoning_effort: ReasoningLevel,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableModel {
    pub id: String,
    pub model: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_provider_id: Option<String>,
    pub description: String,
    pub supported_reasoning_efforts: Vec<ModelReasoningEffort>,
    pub default_reasoning_effort: ReasoningLevel,
    pub is_default: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModels {
    pub models: Vec<AvailableModel>,
    pub selected_only_models: Vec<AvailableModel>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ToolCallOutputItem {
    InputText {
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    InputImage {
        image_url: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallResponse {
    pub content_items: Vec<ToolCallOutputItem>,
    pub success: bool,
}

impl ToolCallResponse {
    pub fn text(text: impl Into<String>, success: bool) -> Self {
        Self { content_items: vec![ToolCallOutputItem::InputText { text: text.into() }], success }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivered {
    pub delivered: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn submit_mode_matches_wire_shape() {
        let steer = SubmitTurnMode::Steer { expected_turn_id: "t1".into() };
        assert_eq!(
            serde_json::to_value(&steer).unwrap(),
            json!({"kind": "steer", "expectedTurnId": "t1"})
        );
        assert_eq!(serde_json::to_value(SubmitTurnMode::Auto).unwrap(), json!({"kind": "auto"}));
    }

    #[test]
    fn permission_mode_clamps_to_ceiling() {
        let clamped = PermissionMode::Full.clamp_to_ceiling(PermissionMode::Auto, None);
        assert_eq!(clamped, Some(PermissionMode::Auto));
        let only_full = [PermissionMode::Full];
        assert_eq!(
            PermissionMode::Full.clamp_to_ceiling(PermissionMode::Auto, Some(&only_full)),
            None
        );
    }
}
