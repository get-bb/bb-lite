//! Plugin manifests (`package.json` `bb` block) and the external plugin list in `config.json`.

use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

use super::api::{PluginError, PluginResult};

#[derive(Clone, Debug, PartialEq)]
pub struct PluginManifest {
    pub id: String,
    pub directory: PathBuf,
    pub name: String,
    pub description: String,
    pub icon: Option<String>,
    pub server_entry: Option<PathBuf>,
    pub app_entry: Option<PathBuf>,
    pub skill_dirs: Vec<PathBuf>,
}

#[derive(Deserialize)]
struct PackageJson {
    name: String,
    bb: BbBlock,
}

#[derive(Deserialize)]
struct BbBlock {
    name: String,
    #[serde(default)]
    description: String,
    icon: Option<String>,
    server: Option<String>,
    app: Option<String>,
    #[serde(default)]
    skills: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ExternalPluginEntry {
    pub path: String,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
}

fn enabled_by_default() -> bool {
    true
}

#[derive(Deserialize)]
struct ConfigJson {
    #[serde(default)]
    plugins: Vec<ExternalPluginEntry>,
}

pub fn derive_plugin_id(package_name: &str) -> PluginResult<String> {
    let base = package_name.rsplit('/').next().unwrap_or(package_name);
    let base = base.strip_prefix("bb-plugin-").unwrap_or(base);
    let replaced: String = base
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' { c } else { '-' })
        .collect();
    let id = replaced.trim_matches('-').to_owned();
    if id.is_empty() {
        return Err(PluginError::new(format!(
            "cannot derive a plugin id from package name \"{package_name}\""
        )));
    }
    Ok(id)
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        normalize(path)
    } else {
        let cwd = std::env::current_dir().unwrap_or_default();
        normalize(&cwd.join(path))
    }
}

/// `directory/path` normalized, or `None` when it escapes `directory`.
pub fn resolve_inside(directory: &Path, path: &str) -> Option<PathBuf> {
    let resolved = absolute(&directory.join(path));
    let directory = absolute(directory);
    (resolved != directory && resolved.starts_with(&directory)).then_some(resolved)
}

fn non_empty(value: &str, field: &str) -> PluginResult<()> {
    if value.is_empty() {
        return Err(PluginError::new(format!("Invalid package.json: \"{field}\" is empty")));
    }
    Ok(())
}

pub async fn read_manifest(path: &Path) -> PluginResult<PluginManifest> {
    let directory = absolute(path);
    let text = tokio::fs::read_to_string(directory.join("package.json"))
        .await
        .map_err(|error| PluginError::new(error.to_string()))?;
    let package: PackageJson = serde_json::from_str(&text)
        .map_err(|error| PluginError::new(format!("Invalid package.json: {error}")))?;
    let bb = package.bb;
    non_empty(&package.name, "name")?;
    non_empty(&bb.name, "bb.name")?;
    for (value, field) in [(&bb.icon, "bb.icon"), (&bb.server, "bb.server"), (&bb.app, "bb.app")] {
        if let Some(value) = value {
            non_empty(value, field)?;
        }
    }
    let inside = |entry: &str| {
        resolve_inside(&directory, entry)
            .ok_or_else(|| PluginError::new(format!("\"{entry}\" is outside the plugin directory")))
    };
    let server_entry = bb.server.as_deref().map(inside).transpose()?;
    let app_entry = bb.app.as_deref().map(inside).transpose()?;
    let skill_dirs = bb.skills.iter().map(|skill| inside(skill)).collect::<PluginResult<_>>()?;
    Ok(PluginManifest {
        id: derive_plugin_id(&package.name)?,
        directory: directory.clone(),
        name: bb.name,
        description: bb.description,
        icon: bb.icon,
        server_entry,
        app_entry,
        skill_dirs,
    })
}

pub async fn read_external_plugin_entries(
    config_file: &Path,
) -> PluginResult<Vec<ExternalPluginEntry>> {
    let text = tokio::fs::read_to_string(config_file).await.unwrap_or_else(|_| "{}".to_owned());
    let config: ConfigJson = serde_json::from_str(&text)
        .map_err(|error| PluginError::new(format!("Invalid config.json: {error}")))?;
    if config.plugins.iter().any(|entry| entry.path.is_empty()) {
        return Err(PluginError::new("Invalid config.json: a plugin path is empty"));
    }
    Ok(config.plugins)
}
