use crate::context::Ctx;
use crate::domain::environment::Environment;
use crate::error::ApiResult;

pub fn require_environment(_ctx: &Ctx, _environment_id: &str) -> ApiResult<Environment> {
    todo!("environments/workspace port")
}

/// The environment, refused unless it is ready; its `path` is then set.
pub fn require_ready_environment(_ctx: &Ctx, _environment_id: &str) -> ApiResult<Environment> {
    todo!("environments/workspace port")
}

pub fn require_thread_environment(_ctx: &Ctx, _thread_id: &str) -> ApiResult<Environment> {
    todo!("environments/workspace port")
}

pub fn branch_search(_query: &serde_json::Map<String, serde_json::Value>) -> serde_json::Value {
    todo!("environments/workspace port")
}

pub async fn search_workspace_paths(
    _ctx: &Ctx,
    _host_id: &str,
    _path: &str,
    _query: &serde_json::Map<String, serde_json::Value>,
) -> ApiResult<serde_json::Value> {
    todo!("environments/workspace port")
}
