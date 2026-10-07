use serde::Serialize;
use serde_json::{Map, Value};

use crate::db::settings::{Setting, read_setting, write_setting};
use crate::db::{Db, DbResult};
use crate::error::{ApiResult, invalid_request};

struct ProviderToggle {
    key: &'static str,
    label: &'static str,
    description: &'static str,
    default: bool,
    option: &'static str,
    inverted: bool,
}

type ToggleValues = Map<String, Value>;

const DISABLE_SUBAGENTS_LABEL: &str = "Disable provider subagents";
const DISABLE_SUBAGENTS_OPTION: &str = "providerSubagentsEnabled";

const CODEX_TOGGLES: &[ProviderToggle] = &[
    ProviderToggle {
        key: "memoryEnabled",
        label: "Codex memory",
        description: "Allow Codex to recall existing memories and generate new memories from bb \
                      threads.",
        default: true,
        option: "memoryEnabled",
        inverted: false,
    },
    ProviderToggle {
        key: "subagentsDisabled",
        label: DISABLE_SUBAGENTS_LABEL,
        description: "Prevent Codex from starting native subagents so agents use bb for \
                      delegation.",
        default: false,
        option: DISABLE_SUBAGENTS_OPTION,
        inverted: true,
    },
];

const CLAUDE_CODE_TOGGLES: &[ProviderToggle] = &[
    ProviderToggle {
        key: "memoryEnabled",
        label: "Claude Code memory",
        description: "Allow Claude Code to read and write its native auto-memory for bb threads.",
        default: true,
        option: "memoryEnabled",
        inverted: false,
    },
    ProviderToggle {
        key: "subagentsDisabled",
        label: DISABLE_SUBAGENTS_LABEL,
        description: "Hide Claude Code's native Task tool so agents use bb for delegation.",
        default: false,
        option: DISABLE_SUBAGENTS_OPTION,
        inverted: true,
    },
    ProviderToggle {
        key: "workflowsDisabled",
        label: "Disable Workflow tool",
        description: "Hide Claude Code's native Workflow tool for bb threads.",
        default: false,
        option: "workflowsEnabled",
        inverted: true,
    },
    ProviderToggle {
        key: "disable1MContext",
        label: "Disable 1M context",
        description: "Disable the 1M-token context window for Claude Code threads. Applies on the \
                      next turn.",
        default: false,
        option: "disable1MContext",
        inverted: false,
    },
    ProviderToggle {
        key: "chromeEnabled",
        label: "Claude in Chrome",
        description: "Start Claude Code with the Claude in Chrome browser tools. Needs the Chrome \
                      extension and a claude.ai login on the host.",
        default: false,
        option: "chromeEnabled",
        inverted: false,
    },
];

const CODEX_SETTING: Setting<ToggleValues> =
    Setting { key: "providerSettings:codex", parse: parse_toggle_values, fallback: Map::new };
const CLAUDE_CODE_SETTING: Setting<ToggleValues> =
    Setting { key: "providerSettings:claude-code", parse: parse_toggle_values, fallback: Map::new };

/// Providers that have a `/plugins/provider-<id>/settings` page, in declaration order.
pub const PROVIDERS_WITH_SETTINGS: [&str; 2] = ["codex", "claude-code"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettingDescriptor {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub label: String,
    pub description: String,
    pub default: bool,
}

/// `PluginSettingsResponse` for a provider: `ok` is always `true`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProviderSettingsView {
    pub ok: bool,
    pub schema: indexmap::IndexMap<String, ProviderSettingDescriptor>,
    pub values: Map<String, Value>,
}

fn parse_toggle_values(value: &Value) -> Option<ToggleValues> {
    let object = value.as_object()?;
    object.values().all(Value::is_boolean).then(|| object.clone())
}

fn provider_toggles(
    provider_id: &str,
) -> Option<(&'static [ProviderToggle], &'static Setting<ToggleValues>)> {
    match provider_id {
        "codex" => Some((CODEX_TOGGLES, &CODEX_SETTING)),
        "claude-code" => Some((CLAUDE_CODE_TOGGLES, &CLAUDE_CODE_SETTING)),
        _ => None,
    }
}

fn read_toggle_values(db: &Db, provider_id: &str) -> DbResult<ToggleValues> {
    let Some((toggles, setting)) = provider_toggles(provider_id) else {
        return Ok(Map::new());
    };
    let stored = read_setting(db, setting)?;
    Ok(toggles
        .iter()
        .map(|toggle| {
            let value = stored.get(toggle.key).cloned().unwrap_or(Value::Bool(toggle.default));
            (toggle.key.to_string(), value)
        })
        .collect())
}

pub fn provider_options_for(db: &Db, provider_id: &str) -> DbResult<Map<String, Value>> {
    let values = read_toggle_values(db, provider_id)?;
    let toggles = provider_toggles(provider_id).map(|(toggles, _)| toggles).unwrap_or_default();
    Ok(toggles
        .iter()
        .map(|toggle| {
            let enabled = values.get(toggle.key) == Some(&Value::Bool(true));
            (toggle.option.to_string(), Value::Bool(enabled != toggle.inverted))
        })
        .collect())
}

pub fn provider_settings_view(db: &Db, provider_id: &str) -> DbResult<ProviderSettingsView> {
    let toggles = provider_toggles(provider_id).map(|(toggles, _)| toggles).unwrap_or_default();
    let schema = toggles
        .iter()
        .map(|toggle| {
            let descriptor = ProviderSettingDescriptor {
                kind: "boolean",
                label: toggle.label.to_string(),
                description: toggle.description.to_string(),
                default: toggle.default,
            };
            (toggle.key.to_string(), descriptor)
        })
        .collect();
    Ok(ProviderSettingsView { ok: true, schema, values: read_toggle_values(db, provider_id)? })
}

pub fn update_provider_settings(
    db: &Db,
    provider_id: &str,
    values: &Map<String, Value>,
) -> ApiResult<()> {
    let mut next = read_toggle_values(db, provider_id)?;
    for (key, value) in values {
        if !next.contains_key(key) {
            return Err(invalid_request(format!("Unknown setting '{key}'")));
        }
        if !value.is_boolean() {
            return Err(invalid_request(format!("Setting '{key}' must be true or false")));
        }
        next.insert(key.clone(), value.clone());
    }
    if let Some((_, setting)) = provider_toggles(provider_id) {
        write_setting(db, setting, &next)?;
    }
    Ok(())
}
