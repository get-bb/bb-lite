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
