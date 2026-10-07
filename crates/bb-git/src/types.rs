use serde::{Deserialize, Serialize};

pub const STATUS_MAX_FILES: usize = 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RepoKind {
    WorkTree,
    Bare,
    None,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NameStatusEntry {
    pub path: String,
    pub previous_path: Option<String>,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NumstatEntry {
    pub path: String,
    pub insertions: Option<i64>,
    pub deletions: Option<i64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineStats {
    pub insertions: i64,
    pub deletions: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitDirs {
    pub git_dir: std::path::PathBuf,
    pub common_dir: std::path::PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum GitCheckoutRef {
    Branch { branch_name: String, head_sha: Option<String> },
    Detached { head_sha: Option<String> },
    Unborn { branch_name: Option<String> },
    Unknown { reason: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum WorkspaceGitOperation {
    None,
    Merge { has_conflicts: bool },
    Rebase { has_conflicts: bool },
    CherryPick { has_conflicts: bool },
    Revert { has_conflicts: bool },
    Unknown { reason: String, has_conflicts: bool },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DefaultBranchRelation {
    Equal,
    LocalBehind,
    LocalAhead,
    Diverged,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathInspection {
    pub exists: bool,
    pub is_git_repo: bool,
    pub is_worktree: bool,
    pub branch_name: Option<String>,
    pub default_branch: Option<String>,
    pub remote_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSourceInspection {
    pub checkout: GitCheckoutRef,
    pub default_branch: Option<String>,
    pub default_branch_relation: Option<DefaultBranchRelation>,
    pub is_worktree: bool,
    pub has_uncommitted_changes: bool,
    pub operation: WorkspaceGitOperation,
    pub origin_default_branch: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitBranchKind {
    Local,
    Remote,
    Missing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitBranchRefClassification {
    pub name: String,
    pub kind: GitBranchKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchOptions {
    pub branches: Vec<String>,
    pub branches_truncated: bool,
    pub remote_branches: Vec<String>,
    pub remote_branches_truncated: bool,
    pub selected_branch: Option<GitBranchRefClassification>,
}

pub type EnvironmentDiffBranchesResponse = GitBranchOptions;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum WorkspaceFileStatusKind {
    M,
    A,
    D,
    R,
    C,
    U,
    #[serde(rename = "??")]
    Untracked,
    #[serde(rename = "?")]
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceFileStatus {
    pub path: String,
    pub status: WorkspaceFileStatusKind,
    pub insertions: Option<i64>,
    pub deletions: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCommitSummary {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub author_name: String,
    pub authored_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceState {
    Clean,
    Untracked,
    DirtyUncommitted,
    CommittedUnmerged,
    DirtyAndCommittedUnmerged,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWorkingTree {
    pub has_uncommitted_changes: bool,
    pub state: WorkspaceState,
    pub insertions: i64,
    pub deletions: i64,
    pub line_stats_complete: bool,
    pub files: Vec<WorkspaceFileStatus>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBranch {
    pub current_branch: Option<String>,
    pub default_branch: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMergeBase {
    pub merge_base_branch: String,
    pub base_ref: Option<String>,
    pub ahead_count: i64,
    pub behind_count: i64,
    pub has_committed_unmerged_changes: bool,
    pub commits: Vec<WorkspaceCommitSummary>,
    pub files: Vec<WorkspaceFileStatus>,
    pub insertions: i64,
    pub deletions: i64,
    pub line_stats_complete: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatus {
    pub working_tree: WorkspaceWorkingTree,
    pub checkout: GitCheckoutRef,
    pub branch: WorkspaceBranch,
    pub merge_base: Option<WorkspaceMergeBase>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PathArgs {
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListBranchesArgs {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_branch: Option<String>,
    pub limit: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusArgs {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_base_branch: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitCommitArgs {
    pub path: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
    pub commit_sha: String,
    pub commit_subject: String,
}
