//! A plugin's settings: non-secret values in `plugin_settings`, secret ones
//! as owner-only files under the plugin's `secrets/` directory.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{Value, json};

use super::api::{SettingDescriptors, SettingRecord, SettingsListener};
use crate::db::Db;
use crate::db::plugins::{PluginRowTable, read_plugin_rows, write_plugin_row};
use crate::error::{ApiResult, invalid_request};

const SECRET_FILE_MODE: u32 = 0o600;

pub struct PluginSettings {
    db: Db,
    plugin_id: String,
    secrets_dir: PathBuf,
    descriptors: Mutex<SettingDescriptors>,
    listeners: Mutex<Vec<SettingsListener>>,
}

impl PluginSettings {
    pub fn new(db: Db, plugin_id: &str, secrets_dir: PathBuf) -> Self {
        let (descriptors, listeners) = (Mutex::default(), Mutex::default());
        Self { db, plugin_id: plugin_id.to_owned(), secrets_dir, descriptors, listeners }
    }

    pub fn descriptors(&self) -> SettingDescriptors {
        self.descriptors.lock().clone()
    }

    pub fn define(&self, descriptors: SettingDescriptors) {
        self.descriptors.lock().extend(descriptors);
    }

    pub fn on_change(&self, listener: SettingsListener) {
        self.listeners.lock().push(listener);
    }

    pub async fn read(&self) -> ApiResult<SettingRecord> {
        let rows = read_plugin_rows(&self.db, PluginRowTable::PluginSettings, &self.plugin_id, "")?;
        let mut values = SettingRecord::new();
        for (key, descriptor) in self.descriptors() {
            let stored = if descriptor.is_secret() {
                match tokio::fs::read_to_string(self.secrets_dir.join(&key)).await {
                    Ok(text) => Value::String(text),
                    Err(_) => Value::Null,
                }
            } else {
                match rows.get(&key) {
                    Some(text) => serde_json::from_str(text)?,
                    None => Value::Null,
                }
            };
            if let Some(value) = descriptor.accept(&stored).or_else(|| descriptor.default_value()) {
                values.insert(key, value);
            }
        }
        Ok(values)
    }

    /// Writes the given keys (`null` clears one) and returns every value.
    pub async fn write(&self, update: &IndexMap<String, Value>) -> ApiResult<SettingRecord> {
        let descriptors = self.descriptors();
        let mut entries = Vec::new();
        for (key, value) in update {
            let Some(descriptor) = descriptors.get(key) else {
                return Err(invalid_request(format!("Unknown setting \"{key}\"")));
            };
            if !value.is_null() && descriptor.accept(value).is_none() {
                return Err(invalid_request(format!("Invalid value for setting \"{key}\"")));
            }
            entries.push((key, value, descriptor.is_secret()));
        }
        let previous = self.read().await?;
        for (key, value, secret) in entries {
            if !secret {
                let stored = (!value.is_null()).then(|| value.to_string());
                let table = PluginRowTable::PluginSettings;
                write_plugin_row(&self.db, table, &self.plugin_id, key, stored.as_deref())?;
            } else if value.is_null() {
                let removed = tokio::fs::remove_file(self.secrets_dir.join(key)).await;
                removed.or_else(|error| match error.kind() {
                    std::io::ErrorKind::NotFound => Ok(()),
                    _ => Err(error),
                })?;
            } else {
                tokio::fs::create_dir_all(&self.secrets_dir).await?;
                let directory = std::fs::Permissions::from_mode(0o700);
                tokio::fs::set_permissions(&self.secrets_dir, directory).await?;
                let file = self.secrets_dir.join(key);
                tokio::fs::write(&file, value.as_str().unwrap_or_default()).await?;
                let mode = std::fs::Permissions::from_mode(SECRET_FILE_MODE);
                tokio::fs::set_permissions(&file, mode).await?;
            }
        }
        let next = self.read().await?;
        if next != previous {
            let listeners = self.listeners.lock().clone();
            for listener in listeners {
                listener(&next, &previous);
            }
        }
        Ok(next)
    }

    /// What the settings page may see: a secret shows only whether it is set.
    pub async fn public_values(&self) -> ApiResult<IndexMap<String, Value>> {
        let values = self.read().await?;
        let mut visible = IndexMap::new();
        for (key, descriptor) in self.descriptors() {
            let value = values.get(&key);
            if descriptor.is_secret() {
                let set = value.and_then(Value::as_str).is_some_and(|text| !text.is_empty());
                visible.insert(key, json!({ "set": set }));
            } else if let Some(value) = value {
                visible.insert(key, value.clone());
            }
        }
        Ok(visible)
    }
}
