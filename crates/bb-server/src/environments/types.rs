use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::db::threads::ThreadRow;

pub const ENVIRONMENT_PROVIDER_IDS: [&str; 3] =
    ["project-checkout", "git-worktree", "personal-workspace"];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum EnvironmentIntent {
    #[serde(rename_all = "camelCase")]
    Reuse { environment_id: String },
    #[serde(rename_all = "camelCase")]
    Provider { environment_provider_id: String, host_id: String, inputs: Option<Value> },
    #[serde(rename_all = "camelCase")]
    ProjectDefault { host_id: String },
}

/// Receives `ProvisioningTranscriptEntry` JSON as the environment is prepared.
pub type ProgressSink = Arc<dyn Fn(Vec<Value>) + Send + Sync>;

#[derive(Clone)]
pub struct EnsureEnvironmentArgs {
    pub thread: ThreadRow,
    pub intent: EnvironmentIntent,
    pub on_progress: ProgressSink,
    pub signal: CancellationToken,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadEnvironment {
    pub environment_id: String,
    pub path: String,
}
