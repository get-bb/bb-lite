use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const USER_QUESTION_MAX_QUESTIONS: usize = 4;
pub const USER_QUESTION_MAX_OPTIONS: usize = 4;
pub const USER_QUESTION_MAX_SELECTED: usize = 4;
pub const USER_QUESTION_MAX_FREE_TEXT_LENGTH: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PendingInteractionStatus {
    Pending,
    Resolving,
    Resolved,
    Interrupted,
}

impl PendingInteractionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Resolving => "resolving",
            Self::Resolved => "resolved",
            Self::Interrupted => "interrupted",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PendingInteractionOriginKind {
    Provider,
    Plugin,
}

impl PendingInteractionOriginKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Provider => "provider",
            Self::Plugin => "plugin",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PendingInteractionOrigin {
    Provider {
        #[serde(rename = "providerId")]
        provider_id: String,
        #[serde(rename = "providerThreadId")]
        provider_thread_id: String,
        #[serde(rename = "providerRequestId")]
        provider_request_id: String,
    },
    Plugin {
        #[serde(rename = "pluginId")]
        plugin_id: String,
        #[serde(rename = "rendererId")]
        renderer_id: String,
    },
}

/// `PendingInteraction` (provider or plugin). `payload` and `resolution` stay
/// JSON: their shapes are `pendingInteractionPayloadSchema` and
/// `pendingInteractionResolutionSchema` (plus the plugin variants). The
/// provider fields are present only for provider interactions.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInteraction {
    pub id: String,
    pub thread_id: String,
    pub status: PendingInteractionStatus,
    pub status_reason: Option<String>,
    pub created_at: i64,
    #[serde(default)]
    pub expires_at: Option<i64>,
    pub resolved_at: Option<i64>,
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_request_id: Option<String>,
    pub origin: PendingInteractionOrigin,
    pub payload: Value,
    pub resolution: Option<Value>,
}

fn payload_kind(payload: &Value) -> Option<&str> {
    payload.get("kind").and_then(Value::as_str)
}

pub fn is_approval_pending_interaction_payload(payload: &Value) -> bool {
    payload_kind(payload) == Some("approval")
}

pub fn is_user_question_pending_interaction_payload(payload: &Value) -> bool {
    payload_kind(payload) == Some("user_question")
}

impl PendingInteraction {
    pub fn payload_kind(&self) -> Option<&str> {
        payload_kind(&self.payload)
    }

    pub fn is_plugin(&self) -> bool {
        self.payload_kind() == Some("plugin")
    }

    pub fn is_approval(&self) -> bool {
        self.payload_kind() == Some("approval")
    }

    pub fn is_user_question(&self) -> bool {
        self.payload_kind() == Some("user_question")
    }

    pub fn is_active(&self) -> bool {
        matches!(
            self.status,
            PendingInteractionStatus::Pending | PendingInteractionStatus::Resolving
        )
    }
}
