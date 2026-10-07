use std::collections::BTreeMap;

use crate::context::Ctx;
use crate::error::ApiResult;

pub async fn resolve_contributed_environment(
    _ctx: &Ctx,
    _project_id: Option<&str>,
) -> ApiResult<BTreeMap<String, String>> {
    todo!("machine-environment port")
}
