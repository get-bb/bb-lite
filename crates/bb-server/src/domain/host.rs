use serde::{Deserialize, Serialize};

pub use bb_core::{PERMISSION_MODES, PermissionMode};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostStatus {
    Connected,
    Disconnected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MachinePhase {
    Creating,
    Active,
    Suspending,
    Suspended,
    Resuming,
    Removing,
    Destroyed,
}

impl MachinePhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Creating => "creating",
            Self::Active => "active",
            Self::Suspending => "suspending",
            Self::Suspended => "suspended",
            Self::Resuming => "resuming",
            Self::Removing => "removing",
            Self::Destroyed => "destroyed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TeardownStatus {
    Running,
    Failed,
    Removed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineTeardown {
    pub status: TeardownStatus,
    pub attempt: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineLifecycle {
    pub phase: MachinePhase,
    pub suspended_at: Option<i64>,
    pub message: Option<String>,
    pub pending_log: String,
    pub teardown: Option<MachineTeardown>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostType {
    Persistent,
    Ephemeral,
}

impl HostType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Persistent => "persistent",
            Self::Ephemeral => "ephemeral",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostPlatform {
    Darwin,
    Linux,
    Wsl,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub host_type: HostType,
    pub status: HostStatus,
    pub machine_provider_id: Option<String>,
    pub lifecycle: MachineLifecycle,
    pub max_permission_mode: PermissionMode,
    pub last_seen_at: Option<i64>,
    pub last_rejected_protocol_version: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateHostPermissionCeilingRequest {
    pub max_permission_mode: PermissionMode,
}

/// `clampPermissionModeToCeiling`: the mode itself when it is within the
/// ceiling, else the most permissive supported mode that is.
pub fn clamp_permission_mode_to_ceiling(
    ceiling: PermissionMode,
    permission_mode: PermissionMode,
    permission_modes: Option<&[PermissionMode]>,
) -> Option<PermissionMode> {
    permission_mode.clamp_to_ceiling(ceiling, permission_modes)
}
