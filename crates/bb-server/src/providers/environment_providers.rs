use serde::{Deserialize, Serialize};

use crate::context::Ctx;
use crate::error::ApiResult;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemEnvironmentProvidersQuery {
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub host_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SystemEnvironmentProvider {}

pub async fn list_environment_providers(
    _ctx: &Ctx,
    _query: SystemEnvironmentProvidersQuery,
) -> ApiResult<Vec<SystemEnvironmentProvider>> {
    todo!("providers/environment-providers port")
}
