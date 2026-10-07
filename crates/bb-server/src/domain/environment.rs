use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EnvironmentMachineSelection {
    #[serde(rename_all = "camelCase")]
    Existing { host_id: String },
    #[serde(rename_all = "camelCase")]
    New { machine_provider_id: String, inputs: Option<Value> },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentProviderSelection {
    pub machine: EnvironmentMachineSelection,
    pub inputs: Option<Value>,
}

impl EnvironmentProviderSelection {
    /// The `min(1)` checks of `environmentProviderSelectionSchema`.
    pub fn is_valid(&self) -> bool {
        match &self.machine {
            EnvironmentMachineSelection::Existing { host_id } => !host_id.is_empty(),
            EnvironmentMachineSelection::New { machine_provider_id, .. } => {
                !machine_provider_id.is_empty()
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnvironmentStatus {
    Creating,
    Provisioning,
    Ready,
    Error,
    Destroyed,
}

pub const ENVIRONMENT_STATUS_VALUES: [EnvironmentStatus; 5] = [
    EnvironmentStatus::Creating,
    EnvironmentStatus::Provisioning,
    EnvironmentStatus::Ready,
    EnvironmentStatus::Error,
    EnvironmentStatus::Destroyed,
];

impl EnvironmentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Creating => "creating",
            Self::Provisioning => "provisioning",
            Self::Ready => "ready",
            Self::Error => "error",
            Self::Destroyed => "destroyed",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        ENVIRONMENT_STATUS_VALUES.into_iter().find(|status| status.as_str() == text)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EnvironmentHostLifecycle {
    Active,
    Removing,
    CleanupFailed,
    Removed,
}

/// The host fields `resolveEnvironmentHostLifecycle` reads.
#[derive(Clone, Copy, Debug)]
pub struct EnvironmentHostState<'a> {
    pub destroyed_at: Option<i64>,
    pub phase: &'a str,
    pub teardown_status: Option<&'a str>,
}

pub fn resolve_environment_host_lifecycle(
    host: Option<EnvironmentHostState<'_>>,
) -> EnvironmentHostLifecycle {
    let Some(host) = host else {
        return EnvironmentHostLifecycle::Removed;
    };
    if host.destroyed_at.is_some() || host.phase == "destroyed" {
        return EnvironmentHostLifecycle::Removed;
    }
    if host.phase != "removing" {
        return EnvironmentHostLifecycle::Active;
    }
    if host.teardown_status == Some("failed") {
        EnvironmentHostLifecycle::CleanupFailed
    } else {
        EnvironmentHostLifecycle::Removing
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceProvisionType {
    Unmanaged,
    ManagedWorktree,
    Personal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EnvironmentWorkspaceDisplayKind {
    ManagedWorktree,
    UnmanagedWorktree,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnvironmentLifecyclePhase {
    Active,
    Retiring,
    Teardown,
    Destroyed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TeardownStatus {
    Running,
    Failed,
    Removed,
}

impl TeardownStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Failed => "failed",
            Self::Removed => "removed",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentTeardown {
    pub status: TeardownStatus,
    pub attempt: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentLifecycle {
    pub phase: EnvironmentLifecyclePhase,
    pub retire_at: Option<i64>,
    pub teardown: Option<EnvironmentTeardown>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub name: Option<String>,
    pub project_id: String,
    pub host_id: String,
    pub path: Option<String>,
    pub is_git_repo: bool,
    pub is_worktree: bool,
    pub branch_name: Option<String>,
    pub base_branch: Option<String>,
    pub default_branch: Option<String>,
    pub merge_base_branch: Option<String>,
    pub status: EnvironmentStatus,
    pub environment_provider_id: Option<String>,
    pub lifecycle: EnvironmentLifecycle,
    pub host_lifecycle: EnvironmentHostLifecycle,
    pub environment_provider_selection: Option<EnvironmentProviderSelection>,
    pub environment_provider_instance_key: Option<String>,
    pub managed: bool,
    pub workspace_provision_type: Option<WorkspaceProvisionType>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceResolutionFailureCode {
    PathNotFound,
    NotGitRepo,
    WorkspaceTypeMismatch,
    PermissionDenied,
    UnknownEnvironment,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceResolutionFailure {
    pub code: WorkspaceResolutionFailureCode,
    pub workspace_path: String,
    pub message: String,
}

pub fn resolve_environment_merge_base_branch(environment: Option<&Environment>) -> Option<String> {
    let environment = environment?;
    environment
        .merge_base_branch
        .as_ref()
        .or(environment.base_branch.as_ref())
        .or(environment.default_branch.as_ref())
        .cloned()
}
