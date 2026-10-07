use indexmap::IndexMap;
use serde::Deserialize;

use super::{Db, DbResult, OnConflict, insert_row, params};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginRowTable {
    PluginKv,
    PluginSettings,
}

impl PluginRowTable {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PluginKv => "plugin_kv",
            Self::PluginSettings => "plugin_settings",
        }
    }
}

#[derive(Deserialize)]
struct KeyValue {
    key: String,
    value: String,
}

pub fn is_plugin_enabled(db: &Db, id: &str) -> DbResult<bool> {
    let enabled: Option<i64> = db.scalar("SELECT enabled FROM plugins WHERE id = ?", [id])?;
    Ok(enabled.is_none_or(|enabled| enabled == 1))
}

pub fn set_plugin_enabled(db: &Db, id: &str, enabled: bool) -> DbResult<()> {
    let values = crate::row! {
        "id" => id,
        "enabled" => enabled,
        "createdAt" => db.now(),
        "updatedAt" => db.now(),
    };
    insert_row(db, "plugins", &values, OnConflict::Update(&["id"]))
}

/// Rows whose key starts with `key_prefix` (`""` for all), in key order.
pub fn read_plugin_rows(
    db: &Db,
    table: PluginRowTable,
    plugin_id: &str,
    key_prefix: &str,
) -> DbResult<IndexMap<String, String>> {
    let table = table.as_str();
    let sql = format!(
        "SELECT key, value FROM {table}
     WHERE plugin_id = ? AND substr(key, 1, ?) = ? ORDER BY key"
    );
    let length = key_prefix.encode_utf16().count() as i64;
    let rows: Vec<KeyValue> = db.all(&sql, params![plugin_id, length, key_prefix])?;
    Ok(rows.into_iter().map(|row| (row.key, row.value)).collect())
}

pub fn write_plugin_row(
    db: &Db,
    table: PluginRowTable,
    plugin_id: &str,
    key: &str,
    value: Option<&str>,
) -> DbResult<()> {
    let table = table.as_str();
    let Some(value) = value else {
        let sql = format!("DELETE FROM {table} WHERE plugin_id = ? AND key = ?");
        db.run(&sql, [plugin_id, key])?;
        return Ok(());
    };
    let row = crate::row! {
        "pluginId" => plugin_id,
        "key" => key,
        "value" => value,
        "updatedAt" => db.now(),
    };
    insert_row(db, table, &row, OnConflict::Update(&["plugin_id", "key"]))
}
