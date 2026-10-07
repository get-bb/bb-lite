//! `POST /threads`. Skeleton of `apps/server/src/threads/create.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::mutations::double_option;
use super::thread_display::ThreadResponse;
use crate::context::Ctx;
use crate::db::Db;
use crate::db::threads::ThreadRow;
use crate::domain::thread::ThreadVisibility;
use crate::error::ApiResult;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSubmission {
    pub plugin_id: String,
    pub data: Value,
}

/// `createThreadRequestSchema`; the `superRefine` checks are `validate`'s job.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateThreadRequest {
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// `ThreadCreateOrigin`.
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_plugin_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_metadata: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle_owner_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visibility: Option<ThreadVisibility>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// `PromptInput[]`.
    pub input: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_input_sources: Option<Value>,
    /// `CreateThreadEnvironmentArgs`.
    pub environment: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]
    pub section_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    /// `StartedOnBehalfOf | null`, defaulting to null.
    #[serde(default)]
    pub started_on_behalf_of: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_submission: Option<PluginSubmission>,
}

pub fn require_valid_parent(
    _db: &Db,
    _parent_thread_id: &str,
    _child: Option<&ThreadRow>,
) -> ApiResult<ThreadRow> {
    todo!("create port")
}

pub async fn create_thread(_ctx: &Ctx, _request: CreateThreadRequest) -> ApiResult<ThreadResponse> {
    todo!("create port")
}
