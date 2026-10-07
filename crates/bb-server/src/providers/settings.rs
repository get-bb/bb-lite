use serde_json::{Map, Value};

use crate::db::{Db, DbResult};

pub fn provider_options_for(_db: &Db, _provider_id: &str) -> DbResult<Map<String, Value>> {
    todo!("providers/settings port")
}
