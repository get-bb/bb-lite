use serde_json::Value;

use crate::db::Db;

pub struct ProviderDefinitionInfo {
    pub capabilities: Value,
}

pub struct ProviderDefinition {
    pub info: ProviderDefinitionInfo,
}

pub fn find_provider_definition(_db: &Db, _provider_id: &str) -> Option<ProviderDefinition> {
    todo!("providers/catalog port")
}
