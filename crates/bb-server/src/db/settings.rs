use serde::Serialize;
use serde_json::{Map, Value};

use super::{Db, DbResult, OnConflict, insert_row};
use crate::domain::settings::{
    AppKeybindingOverrides, AppSettings, AppTheme, parse_app_theme,
    parse_known_keybinding_overrides, parse_partial_app_settings,
};

/// A row of the `settings` table: its key, how a stored value is parsed
/// (`None` falls back) and the value used when nothing valid is stored.
pub struct Setting<T> {
    pub key: &'static str,
    pub parse: fn(&Value) -> Option<T>,
    pub fallback: fn() -> T,
}

pub const KEYBINDING_OVERRIDES_SETTING: Setting<AppKeybindingOverrides> = Setting {
    key: "keybindingOverrides",
    parse: parse_known_keybinding_overrides,
    fallback: Vec::new,
};

pub const APPEARANCE_SETTING: Setting<AppTheme> =
    Setting { key: "appearance", parse: parse_app_theme, fallback: AppTheme::default };

const GENERAL_SETTING: Setting<Map<String, Value>> =
    Setting { key: "general", parse: parse_partial_app_settings, fallback: Map::new };

pub fn read_setting<T>(db: &Db, setting: &Setting<T>) -> DbResult<T> {
    let value: Option<String> =
        db.scalar("SELECT value FROM settings WHERE key = ?", [setting.key])?;
    let Some(value) = value else {
        return Ok((setting.fallback)());
    };
    let stored: Value = serde_json::from_str(&value)?;
    Ok((setting.parse)(&stored).unwrap_or_else(setting.fallback))
}

pub fn write_setting<T: Serialize>(db: &Db, setting: &Setting<T>, value: &T) -> DbResult<()> {
    let row = crate::row! {
        "key" => setting.key,
        "value" => serde_json::to_string(value)?,
        "updatedAt" => db.now(),
    };
    insert_row(db, "settings", &row, OnConflict::Update(&["key"]))
}

pub fn get_app_settings(db: &Db) -> DbResult<AppSettings> {
    let mut settings = match serde_json::to_value(AppSettings::default())? {
        Value::Object(defaults) => defaults,
        _ => Map::new(),
    };
    settings.extend(read_setting(db, &GENERAL_SETTING)?);
    Ok(serde_json::from_value(Value::Object(settings))?)
}

pub fn set_app_settings(db: &Db, settings: &AppSettings) -> DbResult<()> {
    let value = match serde_json::to_value(settings)? {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    write_setting(db, &GENERAL_SETTING, &value)
}
