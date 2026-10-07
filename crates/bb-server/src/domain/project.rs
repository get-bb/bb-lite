use bb_core::{PermissionMode, ReasoningLevel, ServiceTier};
use serde::{Deserialize, Serialize};

pub const PERSONAL_PROJECT_ID: &str = "proj_personal";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectKind {
    Standard,
    Personal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub kind: ProjectKind,
    pub name: String,
    pub git_remote_url: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ProjectSourceType {
    #[serde(rename = "local_path")]
    LocalPath,
}

/// `ProjectSource`; the only kind is `local_path`, so this is also
/// `LocalPathProjectSource`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSource {
    pub id: String,
    pub project_id: String,
    #[serde(rename = "type")]
    pub source_type: ProjectSourceType,
    pub host_id: String,
    pub path: String,
    pub is_default: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

pub type LocalPathProjectSource = ProjectSource;

pub fn find_local_path_project_source_for_host<'a>(
    sources: &'a [ProjectSource],
    host_id: &str,
) -> Option<&'a ProjectSource> {
    sources.iter().find(|source| {
        source.source_type == ProjectSourceType::LocalPath && source.host_id == host_id
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectExecutionDefaults {
    pub provider_id: String,
    pub model: String,
    pub service_tier: ServiceTier,
    pub reasoning_level: ReasoningLevel,
    pub permission_mode: PermissionMode,
}

impl ProjectExecutionDefaults {
    /// The `min(1)` checks of `projectExecutionDefaultsSchema`.
    pub fn is_valid(&self) -> bool {
        !self.provider_id.is_empty() && !self.model.is_empty()
    }
}

/// `ProjectResponse` from the server contract: a project with its sources.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectResponse {
    #[serde(flatten)]
    pub project: Project,
    pub sources: Vec<ProjectSource>,
}
