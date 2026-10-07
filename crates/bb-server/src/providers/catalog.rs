use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};

use bb_core::ReasoningLevel as R;
use bb_core::{PermissionMode, ProviderId, ReasoningLevel};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::db::settings::{
    Setting, get_app_settings, read_setting, set_app_settings, write_setting,
};
use crate::db::{Db, DbResult};
use crate::domain::settings::{AppSettings, CompletedTurnDisplay};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderMaintenance {
    pub health: bool,
    pub usage: bool,
    pub installation: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderIcon {
    pub glyph: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderComposerCommand {
    pub trigger: String,
    pub name: String,
    pub trailing_text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProviderComposerAction {
    Skills { trigger: String },
    Goal { command: ProviderComposerCommand },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderIconTint {
    pub light: String,
    pub dark: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStrings {
    pub sign_in_hint: String,
    pub expired_hint: String,
    pub install_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brand_prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_tint: Option<ProviderIconTint>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderOptionDescriptor {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderExtensionKindInfo {
    pub item: bool,
    pub state: bool,
}

/// `domain.ProviderInfo`. `capabilities` stays JSON (`providerCapabilitiesSchema`) because plugin
/// contexts pass it through untouched.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub plugin_id: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<ProviderIcon>,
    pub available: bool,
    pub maintenance: ProviderMaintenance,
    pub logo_url: Option<String>,
    pub capabilities: Value,
    pub composer_actions: Vec<ProviderComposerAction>,
    pub completed_turn_display: CompletedTurnDisplay,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_levels: Option<Vec<ProviderOptionDescriptor>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strings: Option<ProviderStrings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tiers: Option<Vec<ProviderOptionDescriptor>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension_kinds: Option<IndexMap<String, ProviderExtensionKindInfo>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderLogo {
    pub content: &'static str,
    pub hash: String,
}

#[derive(Clone, Debug)]
pub struct ProviderDefinition {
    pub id: ProviderId,
    pub info: ProviderInfo,
    pub plugin_name: String,
    pub reasoning_levels: Vec<ReasoningLevel>,
    pub logo: Option<ProviderLogo>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProviderCatalogEntry {
    pub id: String,
    pub display_name: String,
    pub plugin_id: String,
    pub plugin_name: String,
    pub plugin_enabled: bool,
    pub enabled: bool,
    pub available: bool,
    pub logo_url: Option<String>,
    pub info: Option<ProviderInfo>,
}

struct Capabilities {
    thread_archive: bool,
    thread_rename: bool,
    service_tier: bool,
    native_user_question: bool,
    session_rewind: bool,
}

struct ProviderSeed {
    id: ProviderId,
    display_name: &'static str,
    logo: Option<&'static str>,
    completed_turn_display: CompletedTurnDisplay,
    reasoning_levels: &'static [ReasoningLevel],
    goal_command: bool,
    capabilities: Capabilities,
    strings: Option<ProviderStrings>,
    service_tiers: Option<Vec<ProviderOptionDescriptor>>,
    extension_kinds: Option<IndexMap<String, ProviderExtensionKindInfo>>,
}

const PERMISSION_MODES: [PermissionMode; 3] =
    [PermissionMode::AcceptEdits, PermissionMode::Auto, PermissionMode::Full];
const CLAUDE_FAST_TIER: &str =
    "Faster responses on supported Opus models at a higher cost per token.";
const CODEX_LOGO: &str = include_str!("../../../../apps/server/src/providers/logos/codex.svg");
const CLAUDE_CODE_LOGO: &str =
    include_str!("../../../../apps/server/src/providers/logos/claude-code.svg");

const DISABLED_PROVIDERS_SETTING: Setting<Vec<String>> =
    Setting { key: "disabledProviderIds", parse: parse_string_list, fallback: Vec::new };

static DEV_PROVIDERS_FOR_TESTS: AtomicBool = AtomicBool::new(false);

fn parse_string_list(value: &Value) -> Option<Vec<String>> {
    serde_json::from_value(value.clone()).ok()
}

fn level_label(level: ReasoningLevel) -> &'static str {
    match level {
        ReasoningLevel::None => "None",
        ReasoningLevel::Low => "Low",
        ReasoningLevel::Medium => "Medium",
        ReasoningLevel::High => "High",
        ReasoningLevel::Xhigh => "Extra High",
        ReasoningLevel::Ultracode => "Ultracode",
        ReasoningLevel::Max => "Max",
        ReasoningLevel::Ultra => "Ultra",
    }
}

fn level_description(level: ReasoningLevel) -> Option<&'static str> {
    match level {
        ReasoningLevel::Ultracode => {
            Some("Extra-high effort plus standing workflow orchestration.")
        }
        ReasoningLevel::Ultra => Some("Max effort plus automatic task delegation."),
        _ => None,
    }
}

fn level_descriptor(level: ReasoningLevel) -> ProviderOptionDescriptor {
    let id = serde_json::to_value(level).ok().and_then(|id| id.as_str().map(str::to_string));
    ProviderOptionDescriptor {
        id: id.unwrap_or_default(),
        label: level_label(level).to_string(),
        description: level_description(level).map(str::to_string),
    }
}

fn option(id: &str, label: &str, description: Option<&str>) -> ProviderOptionDescriptor {
    ProviderOptionDescriptor {
        id: id.to_string(),
        label: label.to_string(),
        description: description.map(str::to_string),
    }
}

fn load_logo(content: &'static str) -> ProviderLogo {
    let digest = hex::encode(Sha256::digest(content.as_bytes()));
    ProviderLogo { content, hash: digest[..16].to_string() }
}

fn define_provider(seed: ProviderSeed) -> ProviderDefinition {
    let id = seed.id.as_str();
    let logo = seed.logo.map(load_logo);
    let logo_path = format!("/api/v1/system/providers/{id}/logo");
    let mut composer_actions = vec![
        ProviderComposerAction::Skills { trigger: "/".to_string() },
        ProviderComposerAction::Skills { trigger: "$".to_string() },
    ];
    if seed.goal_command {
        composer_actions.push(ProviderComposerAction::Goal {
            command: ProviderComposerCommand {
                trigger: "/".to_string(),
                name: "goal".to_string(),
                trailing_text: " ".to_string(),
            },
        });
    }
    let capabilities = &seed.capabilities;
    let info = ProviderInfo {
        id: id.to_string(),
        plugin_id: format!("provider-{id}"),
        display_name: seed.display_name.to_string(),
        family: None,
        icon: None,
        available: true,
        maintenance: ProviderMaintenance { health: true, usage: true, installation: true },
        logo_url: logo.as_ref().map(|logo| format!("{logo_path}?h={}", logo.hash)),
        capabilities: json!({
            "supportsThreadArchive": capabilities.thread_archive,
            "supportsThreadRename": capabilities.thread_rename,
            "supportsServiceTier": capabilities.service_tier,
            "supportsNativeUserQuestion": capabilities.native_user_question,
            "supportsSessionRewind": capabilities.session_rewind,
            "permissionModes": PERMISSION_MODES,
            "modelCatalogScope": "host",
        }),
        composer_actions,
        completed_turn_display: seed.completed_turn_display,
        reasoning_levels: Some(
            seed.reasoning_levels.iter().copied().map(level_descriptor).collect(),
        ),
        strings: seed.strings,
        service_tiers: seed.service_tiers,
        extension_kinds: seed.extension_kinds,
    };
    ProviderDefinition {
        id: seed.id,
        info,
        plugin_name: format!("{} provider", seed.display_name),
        reasoning_levels: seed.reasoning_levels.to_vec(),
        logo,
    }
}

fn codex() -> ProviderDefinition {
    define_provider(ProviderSeed {
        id: ProviderId::Codex,
        display_name: "Codex",
        logo: Some(CODEX_LOGO),
        completed_turn_display: CompletedTurnDisplay::Collapse,
        reasoning_levels: &[R::Low, R::Medium, R::High, R::Xhigh, R::Max, R::Ultra],
        goal_command: true,
        capabilities: Capabilities {
            thread_archive: true,
            thread_rename: true,
            service_tier: true,
            native_user_question: false,
            session_rewind: true,
        },
        strings: Some(ProviderStrings {
            sign_in_hint: "Run `codex` on the machine to sign in.".to_string(),
            expired_hint: "Your Codex session expired. Run `codex`, then reload.".to_string(),
            install_url: "https://developers.openai.com/codex/cli".to_string(),
            brand_prefix: Some("GPT-".to_string()),
            icon_tint: None,
        }),
        service_tiers: Some(vec![option("default", "Default", None), option("fast", "Fast", None)]),
        extension_kinds: Some(IndexMap::from([
            (
                "provider-codex/goal".to_string(),
                ProviderExtensionKindInfo { item: false, state: true },
            ),
            (
                "provider-codex/macos-permission".to_string(),
                ProviderExtensionKindInfo { item: true, state: false },
            ),
        ])),
    })
}

fn claude_code() -> ProviderDefinition {
    define_provider(ProviderSeed {
        id: ProviderId::ClaudeCode,
        display_name: "Claude Code",
        logo: Some(CLAUDE_CODE_LOGO),
        completed_turn_display: CompletedTurnDisplay::Flat,
        reasoning_levels: &[R::Low, R::Medium, R::High, R::Xhigh, R::Ultracode, R::Max],
        goal_command: false,
        capabilities: Capabilities {
            thread_archive: false,
            thread_rename: false,
            service_tier: true,
            native_user_question: true,
            session_rewind: true,
        },
        strings: Some(ProviderStrings {
            sign_in_hint: "Run `claude` on the machine to sign in.".to_string(),
            expired_hint: "Your Claude session expired. Run `claude`, then reload.".to_string(),
            install_url: "https://claude.com/claude-code".to_string(),
            brand_prefix: Some("Claude ".to_string()),
            icon_tint: Some(ProviderIconTint {
                light: "#D97757".to_string(),
                dark: "#D97757".to_string(),
            }),
        }),
        service_tiers: Some(vec![
            option("default", "Default", None),
            option("fast", "Fast", Some(CLAUDE_FAST_TIER)),
        ]),
        extension_kinds: None,
    })
}

fn echo() -> ProviderDefinition {
    define_provider(ProviderSeed {
        id: ProviderId::Echo,
        display_name: "Echo",
        logo: None,
        completed_turn_display: CompletedTurnDisplay::Collapse,
        reasoning_levels: &[R::Low, R::Medium, R::High],
        goal_command: false,
        capabilities: Capabilities {
            thread_archive: false,
            thread_rename: false,
            service_tier: false,
            native_user_question: false,
            session_rewind: false,
        },
        strings: None,
        service_tiers: None,
        extension_kinds: None,
    })
}

static CODEX: LazyLock<ProviderDefinition> = LazyLock::new(codex);
static CLAUDE_CODE: LazyLock<ProviderDefinition> = LazyLock::new(claude_code);
static ECHO: LazyLock<ProviderDefinition> = LazyLock::new(echo);

/// Turns on every development provider (`echo`) for this process regardless of
/// `BB_DEV_PROVIDERS`, as running under the test runner does in the original server.
pub fn enable_dev_providers_for_tests() {
    DEV_PROVIDERS_FOR_TESTS.store(true, Ordering::Relaxed);
}

fn dev_provider_enabled(id: &str) -> bool {
    if DEV_PROVIDERS_FOR_TESTS.load(Ordering::Relaxed) {
        return true;
    }
    if std::env::var("VITEST").is_ok_and(|value| value == "true") {
        return true;
    }
    std::env::var("BB_DEV_PROVIDERS").unwrap_or_default().split(',').any(|entry| entry == id)
}

fn rank(order: &[String], id: ProviderId) -> usize {
    order.iter().position(|entry| entry == id.as_str()).unwrap_or(order.len())
}

pub fn list_provider_definitions_in_order(order: &[String]) -> Vec<ProviderDefinition> {
    let mut providers = vec![CODEX.clone(), CLAUDE_CODE.clone()];
    if dev_provider_enabled(ECHO.id.as_str()) {
        providers.push(ECHO.clone());
    }
    providers.sort_by_key(|provider| rank(order, provider.id));
    providers
}

pub fn list_provider_definitions(db: &Db) -> DbResult<Vec<ProviderDefinition>> {
    let AppSettings { provider_order, .. } = get_app_settings(db)?;
    Ok(list_provider_definitions_in_order(&provider_order))
}

/// `findProviderDefinition`. A settings row that cannot be read falls back to the
/// built-in provider order.
pub fn find_provider_definition(db: &Db, provider_id: &str) -> Option<ProviderDefinition> {
    let order = get_app_settings(db).map(|settings| settings.provider_order).unwrap_or_default();
    list_provider_definitions_in_order(&order)
        .into_iter()
        .find(|provider| provider.id.as_str() == provider_id)
}

pub fn disabled_provider_ids(db: &Db) -> DbResult<Vec<String>> {
    read_setting(db, &DISABLED_PROVIDERS_SETTING)
}

pub fn list_enabled_providers(db: &Db) -> DbResult<Vec<ProviderDefinition>> {
    let disabled = disabled_provider_ids(db)?;
    let providers = list_provider_definitions(db)?;
    Ok(providers
        .into_iter()
        .filter(|provider| !disabled.iter().any(|id| id == provider.id.as_str()))
        .collect())
}

pub fn list_provider_catalog(db: &Db) -> DbResult<Vec<SystemProviderCatalogEntry>> {
    let disabled = disabled_provider_ids(db)?;
    let providers = list_provider_definitions(db)?;
    Ok(providers
        .into_iter()
        .map(|ProviderDefinition { id, info, plugin_name, .. }| SystemProviderCatalogEntry {
            id: id.as_str().to_string(),
            display_name: info.display_name.clone(),
            plugin_id: info.plugin_id.clone(),
            plugin_name,
            plugin_enabled: true,
            enabled: !disabled.iter().any(|entry| entry == id.as_str()),
            available: info.available,
            logo_url: info.logo_url.clone(),
            info: Some(info),
        })
        .collect())
}

pub fn set_provider_enabled(db: &Db, provider_id: &str, enabled: bool) -> DbResult<()> {
    let mut disabled: Vec<String> =
        disabled_provider_ids(db)?.into_iter().filter(|id| id != provider_id).collect();
    if !enabled {
        disabled.push(provider_id.to_string());
    }
    write_setting(db, &DISABLED_PROVIDERS_SETTING, &disabled)?;
    let settings = get_app_settings(db)?;
    if !enabled && settings.default_provider_id.as_deref() == Some(provider_id) {
        set_app_settings(db, &AppSettings { default_provider_id: None, ..settings })?;
    }
    Ok(())
}
