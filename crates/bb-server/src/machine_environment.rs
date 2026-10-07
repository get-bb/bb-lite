use std::collections::BTreeMap;

use crate::context::Ctx;
use crate::error::ApiResult;

/// The machine-wide and project environment variables, decrypted.
pub async fn resolve_contributed_environment(
    ctx: &Ctx,
    project_id: Option<&str>,
) -> ApiResult<BTreeMap<String, String>> {
    let sql = "SELECT 1 FROM environment_variables WHERE project_id IS NULL OR project_id IS ?";
    if ctx.db.rows(sql, [project_id])?.is_empty() {
        return Ok(BTreeMap::new());
    }
    todo!("machine-environment port")
}
