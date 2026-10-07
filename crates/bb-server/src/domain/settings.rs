use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const MANAGED_BRANCH_PREFIX_MAX_LENGTH: usize = 64;
pub const DEFAULT_MANAGED_BRANCH_PREFIX: &str = "bb/";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CompletedTurnDisplay {
    Collapse,
    Flat,
}

pub const DEFAULT_COMPLETED_TURN_DISPLAY: CompletedTurnDisplay = CompletedTurnDisplay::Collapse;

/// Fields are in the order of `defaultAppSettings`, which is the order
/// `getAppSettings` answers with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub show_keyboard_hints: bool,
    pub steer_active_thread_on_enter: bool,
    pub confirm_thread_archive: bool,
    pub show_diagnostic_events: bool,
    pub provider_order: Vec<String>,
    pub default_provider_id: Option<String>,
    pub provider_completed_turn_display: IndexMap<String, CompletedTurnDisplay>,
    pub streamer_mode: bool,
    pub allow_fast_service_tier: bool,
    pub telemetry_enabled: bool,
    pub managed_branch_prefix: String,
    pub machine_server_url: Option<String>,
    pub default_machine_access: Option<String>,
    pub machine_git_credentials_enabled: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            show_keyboard_hints: true,
            steer_active_thread_on_enter: true,
            confirm_thread_archive: true,
            show_diagnostic_events: false,
            provider_order: Vec::new(),
            default_provider_id: None,
            provider_completed_turn_display: IndexMap::new(),
            streamer_mode: false,
            allow_fast_service_tier: true,
            telemetry_enabled: true,
            managed_branch_prefix: DEFAULT_MANAGED_BRANCH_PREFIX.to_owned(),
            machine_server_url: None,
            default_machine_access: None,
            machine_git_credentials_enabled: true,
        }
    }
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn non_empty_string(value: &Value) -> bool {
    value.as_str().is_some_and(|text| !text.is_empty())
}

fn nullable(value: &Value, valid: impl Fn(&Value) -> bool) -> bool {
    value.is_null() || valid(value)
}

pub fn is_valid_managed_branch_prefix(prefix: &str) -> bool {
    utf16_len(prefix) <= MANAGED_BRANCH_PREFIX_MAX_LENGTH
        && bb_core::exec::is_valid_git_branch_name(&format!("{prefix}slug-thr_id"))
}

pub fn is_valid_machine_server_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none()
    })
}

/// Whether `value` is valid for the `AppSettings` field `key`; `None` when
/// this build defines no such field.
pub fn app_setting_is_valid(key: &str, value: &Value) -> Option<bool> {
    Some(match key {
        "showKeyboardHints"
        | "steerActiveThreadOnEnter"
        | "confirmThreadArchive"
        | "showDiagnosticEvents"
        | "streamerMode"
        | "allowFastServiceTier"
        | "telemetryEnabled"
        | "machineGitCredentialsEnabled" => value.is_boolean(),
        "providerOrder" => value.as_array().is_some_and(|items| items.iter().all(non_empty_string)),
        "defaultProviderId" | "defaultMachineAccess" => nullable(value, non_empty_string),
        "providerCompletedTurnDisplay" => value.as_object().is_some_and(|map| {
            map.iter().all(|(provider, display)| {
                !provider.is_empty()
                    && serde_json::from_value::<CompletedTurnDisplay>(display.clone()).is_ok()
            })
        }),
        "managedBranchPrefix" => value.as_str().is_some_and(is_valid_managed_branch_prefix),
        "machineServerUrl" => {
            nullable(value, |url| url.as_str().is_some_and(is_valid_machine_server_url))
        }
        _ => return None,
    })
}

/// `appSettingsSchema.partial().strip()`: unknown keys are dropped, and the
/// whole value is refused when a known key holds an invalid value.
pub fn parse_partial_app_settings(value: &Value) -> Option<Map<String, Value>> {
    let object = value.as_object()?;
    let mut known = Map::new();
    for (key, field) in object {
        match app_setting_is_valid(key, field) {
            Some(true) => {
                known.insert(key.clone(), field.clone());
            }
            Some(false) => return None,
            None => {}
        }
    }
    Some(known)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FaviconColorPreference {
    Default,
    Red,
    Orange,
    Yellow,
    Green,
    Teal,
    Blue,
    Purple,
    Pink,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppTheme {
    pub theme_id: String,
    pub favicon_color: FaviconColorPreference,
}

impl Default for AppTheme {
    fn default() -> Self {
        AppTheme { theme_id: "default".to_owned(), favicon_color: FaviconColorPreference::Default }
    }
}

/// `appThemeSchema` (not strict: extra keys are dropped).
pub fn parse_app_theme(value: &Value) -> Option<AppTheme> {
    let theme: AppTheme = serde_json::from_value(value.clone()).ok()?;
    (!theme.theme_id.is_empty()).then_some(theme)
}

pub const APP_COMMAND_IDS: &[&str] = &[
    "palette.open",
    "thread.new",
    "thread.search",
    "thread.rename",
    "thread.archive",
    "thread.previous",
    "thread.next",
    "thread.jump.1",
    "thread.jump.2",
    "thread.jump.3",
    "thread.jump.4",
    "thread.jump.5",
    "thread.jump.6",
    "thread.jump.7",
    "thread.jump.8",
    "thread.jump.9",
    "pane.focus.left",
    "pane.focus.right",
    "pane.focus.up",
    "pane.focus.down",
    "pane.focus.previous",
    "pane.focus.next",
    "pane.focus.1",
    "pane.focus.2",
    "pane.focus.3",
    "pane.focus.4",
    "pane.focus.5",
    "pane.focus.6",
    "pane.focus.7",
    "pane.focus.8",
    "pane.maximize.toggle",
    "pane.close",
    "app.back",
    "settings.open",
    "sidebar.toggle",
    "panel.previousTab",
    "panel.nextTab",
    "panel.previousNewTabItem",
    "panel.nextNewTabItem",
    "panel.newTab",
    "panel.close",
    "panel.toggle",
    "file.quickOpen",
    "diff.toggle",
    "terminal.open",
    "composer.focus",
    "modelPicker.toggle",
    "modelPicker.cycleModel",
    "modelPicker.cycleModelBackward",
    "modelPicker.cycleProvider",
    "modelPicker.cycleProviderBackward",
    "modelPicker.cycleReasoning",
    "modelPicker.cycleReasoningBackward",
    "workspace.openPreferred",
    "question.select.1",
    "question.select.2",
    "question.select.3",
    "question.select.4",
    "question.select.5",
    "question.select.6",
    "question.select.7",
    "question.select.8",
    "question.select.9",
];

pub fn is_plugin_command_id(id: &str) -> bool {
    let Some((plugin, command)) = id.strip_prefix("plugin:").and_then(|rest| rest.split_once('/'))
    else {
        return false;
    };
    let plugin_ok =
        plugin.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            && plugin.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    let command_ok = !command.is_empty()
        && command.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    plugin_ok && command_ok && id.len() <= 256
}

pub fn is_keyboard_command_id(id: &str) -> bool {
    APP_COMMAND_IDS.contains(&id) || is_plugin_command_id(id)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyboardPlatform {
    Mac,
    Windows,
    Linux,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppShortcut {
    pub key: String,
    #[serde(rename = "mod")]
    pub modifier: bool,
    pub meta: bool,
    pub control: bool,
    pub alt: bool,
    pub shift: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppKeybindingOverride {
    pub command: String,
    pub shortcut: Option<AppShortcut>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<KeyboardPlatform>,
}

pub type AppKeybindingOverrides = Vec<AppKeybindingOverride>;

/// One element of `appKeybindingOverridesSchema`, or `None` when it does not
/// match (for example its command no longer exists).
pub fn parse_app_keybinding_override(value: &Value) -> Option<AppKeybindingOverride> {
    let object = value.as_object()?;
    if !object.contains_key("shortcut") || object.get("platform").is_some_and(Value::is_null) {
        return None;
    }
    let parsed: AppKeybindingOverride = serde_json::from_value(value.clone()).ok()?;
    let key_ok = parsed.shortcut.as_ref().is_none_or(|shortcut| {
        let length = utf16_len(&shortcut.key);
        (1..=32).contains(&length)
    });
    (key_ok && is_keyboard_command_id(&parsed.command)).then_some(parsed)
}

/// Stored overrides keep each element whose command still exists.
pub fn parse_known_keybinding_overrides(value: &Value) -> Option<AppKeybindingOverrides> {
    let items = value.as_array()?;
    Some(items.iter().filter_map(parse_app_keybinding_override).collect())
}

const UI_PREFERENCE_STRING_MAX_LENGTH: usize = 1_024;

struct UiPreferenceDefinition {
    key: &'static str,
    default_value: &'static str,
    legacy: &'static str,
    current: &'static str,
}

const UI_PREFERENCE_DEFINITIONS: [UiPreferenceDefinition; 3] = [
    UiPreferenceDefinition {
        key: "sidebar.navigationProvider",
        default_value: "__automatic__",
        legacy: "__builtin__",
        current: "navigation/navigation",
    },
    UiPreferenceDefinition {
        key: "sidebar.headerProvider",
        default_value: "__builtin__",
        legacy: "__automatic__",
        current: "__builtin__",
    },
    UiPreferenceDefinition {
        key: "sidebar.threadListProvider",
        default_value: "__automatic__",
        legacy: "__builtin__",
        current: "thread-list/thread-list",
    },
];

pub const UI_PREFERENCE_KEYS: [&str; 3] =
    ["sidebar.navigationProvider", "sidebar.headerProvider", "sidebar.threadListProvider"];

fn ui_preference_definition(key: &str) -> Option<&'static UiPreferenceDefinition> {
    UI_PREFERENCE_DEFINITIONS.iter().find(|definition| definition.key == key)
}

pub fn is_ui_preference_key(value: &str) -> bool {
    ui_preference_definition(value).is_some()
}

/// The default value, or `None` for a key this build does not define.
pub fn get_ui_preference_default(key: &str) -> Option<&'static str> {
    ui_preference_definition(key).map(|definition| definition.default_value)
}

/// The stored value with legacy names mapped forward, or the zod issue
/// messages joined with "; ". A key this build does not define is an error.
pub fn parse_ui_preference_value(key: &str, value: &Value) -> Result<String, String> {
    let Some(definition) = ui_preference_definition(key) else {
        return Err(format!("Unknown UI preference '{key}'"));
    };
    let Some(text) = value.as_str() else {
        let received = match value {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
            Value::String(_) => "string",
        };
        return Err(format!("Invalid input: expected string, received {received}"));
    };
    let length = utf16_len(text);
    if length < 1 {
        return Err("Too small: expected string to have >=1 characters".to_owned());
    }
    if length > UI_PREFERENCE_STRING_MAX_LENGTH {
        let max = UI_PREFERENCE_STRING_MAX_LENGTH;
        return Err(format!("Too big: expected string to have <={max} characters"));
    }
    let value = if text == definition.legacy { definition.current } else { text };
    Ok(value.to_owned())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPreferenceEntry {
    pub revision: i64,
    pub value: String,
}

pub type UiPreferenceEntries = IndexMap<String, UiPreferenceEntry>;

/// Every key this build defines, from stored `(key, revision, value)` rows:
/// rows for undefined keys are ignored, a missing row is the default at
/// revision 0 and an invalid stored value is the default at the row's revision.
pub fn ui_preference_entries(stored: &[(String, i64, Value)]) -> UiPreferenceEntries {
    UI_PREFERENCE_DEFINITIONS
        .iter()
        .map(|definition| {
            let row = stored.iter().find(|(key, _, _)| key == definition.key);
            let entry = match row {
                None => {
                    UiPreferenceEntry { revision: 0, value: definition.default_value.to_owned() }
                }
                Some((key, revision, value)) => UiPreferenceEntry {
                    revision: *revision,
                    value: parse_ui_preference_value(key, value)
                        .unwrap_or_else(|_| definition.default_value.to_owned()),
                },
            };
            (definition.key.to_owned(), entry)
        })
        .collect()
}
