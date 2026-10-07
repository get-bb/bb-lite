use indexmap::IndexMap;

use crate::context::Ctx;
use crate::error::ApiResult;

pub async fn resolve_contributed_environment(
    _ctx: &Ctx,
    _project_id: Option<&str>,
) -> ApiResult<IndexMap<String, String>> {
    todo!("machine-environment port")
}
