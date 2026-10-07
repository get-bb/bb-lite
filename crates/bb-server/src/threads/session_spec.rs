//! Stub added by the engine skeleton; replaced by the port of `threads/session-spec.ts`.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEnvironment {
    pub id: String,
    pub host_id: String,
    pub path: String,
}
