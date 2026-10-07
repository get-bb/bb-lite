use serde::{Deserialize, Serialize};

use crate::context::Ctx;
use crate::error::ApiResult;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemExecutionOptionsQuery {
    #[serde(default)]
    pub host_id: Option<String>,
    #[serde(default)]
    pub environment_id: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SystemExecutionOptionsResponse {}

pub async fn resolve_execution_options(
    _ctx: &Ctx,
    _query: SystemExecutionOptionsQuery,
) -> ApiResult<SystemExecutionOptionsResponse> {
    todo!("providers/models port")
}
