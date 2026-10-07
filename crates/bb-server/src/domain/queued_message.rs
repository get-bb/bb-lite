use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const QUEUED_MESSAGE_WAIT_HOST_NAME_MAX_LENGTH: usize = 200;
pub const QUEUED_MESSAGE_WAIT_REASON_MAX_LENGTH: usize = 200;
pub const QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH: usize = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QueuedMessageWaitingOnKind {
    Time,
    ThreadBusy,
    Stopping,
    TurnStarting,
    Provisioning,
    HostOffline,
    Interaction,
    Plugin,
}

impl QueuedMessageWaitingOnKind {
    pub const ALL: [QueuedMessageWaitingOnKind; 8] = [
        Self::Time,
        Self::ThreadBusy,
        Self::Stopping,
        Self::TurnStarting,
        Self::Provisioning,
        Self::HostOffline,
        Self::Interaction,
        Self::Plugin,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Time => "time",
            Self::ThreadBusy => "thread-busy",
            Self::Stopping => "stopping",
            Self::TurnStarting => "turn-starting",
            Self::Provisioning => "provisioning",
            Self::HostOffline => "host-offline",
            Self::Interaction => "interaction",
            Self::Plugin => "plugin",
        }
    }
}

/// What a queued message waits for before it can be sent; `None` on the
/// entity means it is simply next in line (or was stored before waits were typed).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum QueuedMessageWaitingOn {
    Time,
    ThreadBusy,
    Stopping,
    TurnStarting,
    Provisioning,
    HostOffline {
        #[serde(rename = "hostName")]
        host_name: String,
    },
    Interaction,
    Plugin {
        #[serde(rename = "pluginId")]
        plugin_id: String,
        reason: String,
    },
}

impl QueuedMessageWaitingOn {
    pub fn kind(&self) -> QueuedMessageWaitingOnKind {
        match self {
            Self::Time => QueuedMessageWaitingOnKind::Time,
            Self::ThreadBusy => QueuedMessageWaitingOnKind::ThreadBusy,
            Self::Stopping => QueuedMessageWaitingOnKind::Stopping,
            Self::TurnStarting => QueuedMessageWaitingOnKind::TurnStarting,
            Self::Provisioning => QueuedMessageWaitingOnKind::Provisioning,
            Self::HostOffline { .. } => QueuedMessageWaitingOnKind::HostOffline,
            Self::Interaction => QueuedMessageWaitingOnKind::Interaction,
            Self::Plugin { .. } => QueuedMessageWaitingOnKind::Plugin,
        }
    }

    /// The length limits of `queuedMessageWaitingOnSchema`.
    pub fn validate(&self) -> Result<(), String> {
        let bounded = |value: &str, max: usize, field: &str| {
            let length = value.encode_utf16().count();
            if length == 0 || length > max {
                Err(format!("{field} must be 1 to {max} characters"))
            } else {
                Ok(())
            }
        };
        match self {
            Self::HostOffline { host_name } => {
                bounded(host_name, QUEUED_MESSAGE_WAIT_HOST_NAME_MAX_LENGTH, "hostName")
            }
            Self::Plugin { plugin_id, reason } => {
                bounded(plugin_id, usize::MAX, "pluginId")?;
                bounded(reason, QUEUED_MESSAGE_WAIT_REASON_MAX_LENGTH, "reason")
            }
            _ => Ok(()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SystemMessageKind {
    OwnershipAssigned,
    OwnershipRemoved,
    ChildNeedsAttention,
    ChildCompleted,
    ChildFailed,
    ChildInterrupted,
    ChildOutcomeBatch,
    ToolResultDelivered,
    Unlabeled,
}

/// `subject` is kept as JSON (`systemMessageSubjectSchema`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessageSystemNotice {
    pub kind: SystemMessageKind,
    pub subject: Option<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadCreateOrigin {
    App,
    Cli,
    Sdk,
    Plugin,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QueuedMessageInitiator {
    User,
    Agent,
    System,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum QueuedMessagePayload {
    Inline,
    Retry {
        #[serde(rename = "retryOfTurnRequestId")]
        retry_of_turn_request_id: String,
        attempt: i64,
        reason: String,
    },
}

/// `ThreadQueuedMessage`; `content` holds `PromptInput` JSON values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadQueuedMessage {
    pub id: String,
    pub origin: Option<ThreadCreateOrigin>,
    pub origin_plugin_id: Option<String>,
    pub initiator: QueuedMessageInitiator,
    pub sender_thread_id: Option<String>,
    pub thread_id: String,
    pub content: Vec<Value>,
    pub model: String,
    pub reasoning_level: String,
    pub permission_mode: String,
    pub service_tier: String,
    pub group_with_next: bool,
    pub send_at: Option<i64>,
    pub waiting_on: Option<QueuedMessageWaitingOn>,
    pub failure_reason: Option<String>,
    pub payload: QueuedMessagePayload,
    pub editable: bool,
    pub created_at: i64,
    pub updated_at: i64,
}
