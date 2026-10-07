use std::sync::LazyLock;

use serde::Serialize;
use serde_json::Value;

use crate::domain::settings::{
    AppKeybindingOverride, AppKeybindingOverrides, AppShortcut, KeyboardPlatform,
    parse_app_keybinding_override,
};

pub const THREAD_JUMP_APP_COMMAND_IDS: [&str; 9] = [
    "thread.jump.1",
    "thread.jump.2",
    "thread.jump.3",
    "thread.jump.4",
    "thread.jump.5",
    "thread.jump.6",
    "thread.jump.7",
    "thread.jump.8",
    "thread.jump.9",
];

pub const QUESTION_SELECT_APP_COMMAND_IDS: [&str; 9] = [
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

pub const PANE_FOCUS_APP_COMMAND_IDS: [&str; 8] = [
    "pane.focus.1",
    "pane.focus.2",
    "pane.focus.3",
    "pane.focus.4",
    "pane.focus.5",
    "pane.focus.6",
    "pane.focus.7",
    "pane.focus.8",
];

const MODIFIERS: [&str; 5] = ["mod", "meta", "control", "alt", "shift"];
const PLATFORMS: [KeyboardPlatform; 3] =
    [KeyboardPlatform::Mac, KeyboardPlatform::Windows, KeyboardPlatform::Linux];
const MAX_OVERRIDES: usize = 1024;

/// The context keys (`AppCommandContextKey`) a binding needs (`all`) or excludes (`none`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AppCommandWhen {
    pub all: Vec<&'static str>,
    pub none: Vec<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AppDefaultKeybinding {
    pub command: String,
    pub shortcut: Option<AppShortcut>,
    pub when: AppCommandWhen,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AppKeybinding {
    pub command: String,
    pub shortcut: AppShortcut,
    pub when: AppCommandWhen,
}

fn when(all: &[&'static str], none: &[&'static str]) -> AppCommandWhen {
    let mut needed = vec!["mainSurface"];
    needed.extend_from_slice(all);
    AppCommandWhen { all: needed, none: none.to_vec() }
}

fn parse_shortcut(keys: &str) -> AppShortcut {
    let parts: Vec<&str> = keys.split('+').collect();
    let (key, held) = parts.split_last().map_or(("", &[][..]), |(key, held)| (*key, held));
    let [modifier, meta, control, alt, shift] = MODIFIERS.map(|name| held.contains(&name));
    AppShortcut { key: key.to_owned(), modifier, meta, control, alt, shift }
}

fn bind(command: &str, keys: Option<&str>, when: &AppCommandWhen) -> AppDefaultKeybinding {
    AppDefaultKeybinding {
        command: command.to_owned(),
        shortcut: keys.map(parse_shortcut),
        when: when.clone(),
    }
}

fn on_mac(when: &AppCommandWhen) -> AppCommandWhen {
    let mut all = when.all.clone();
    all.push("macPlatform");
    AppCommandWhen { all, none: when.none.clone() }
}

fn off_mac(when: &AppCommandWhen) -> AppCommandWhen {
    let mut none = when.none.clone();
    none.push("macPlatform");
    AppCommandWhen { all: when.all.clone(), none }
}

fn mac_only(command: &str, keys: &str, when: &AppCommandWhen) -> [AppDefaultKeybinding; 2] {
    [bind(command, Some(keys), &on_mac(when)), bind(command, None, &off_mac(when))]
}

fn numbered(commands: &[&str], when: &AppCommandWhen) -> Vec<AppDefaultKeybinding> {
    let mut web = when.clone();
    web.all.push("webSurface");
    commands
        .iter()
        .enumerate()
        .flat_map(|(index, command)| {
            [
                bind(command, Some(&format!("control+{}", index + 1)), &on_mac(&web)),
                bind(command, Some(&format!("mod+shift+{}", index + 1)), &off_mac(&web)),
            ]
        })
        .collect()
}

fn model_picker(when: &AppCommandWhen) -> [AppDefaultKeybinding; 6] {
    [
        bind("modelPicker.cycleModel", Some("alt+m"), when),
        bind("modelPicker.cycleModelBackward", Some("alt+shift+m"), when),
        bind("modelPicker.cycleProvider", Some("alt+p"), when),
        bind("modelPicker.cycleProviderBackward", Some("alt+shift+p"), when),
        bind("modelPicker.cycleReasoning", Some("alt+t"), when),
        bind("modelPicker.cycleReasoningBackward", Some("alt+shift+t"), when),
    ]
}

fn default_app_keybindings() -> Vec<AppDefaultKeybinding> {
    let modal = &["modalOpen"][..];
    let main = when(&[], modal);
    let web_main = when(&["webSurface"], modal);
    let split = when(&["splitActive"], modal);
    let picker_open = when(&["modelPickerOpen"], &[]);
    let question = when(&["questionOpen"], &["modalOpen", "editableFocus"]);
    let outside_editors =
        when(&[], &["modalOpen", "editableFocus", "terminalFocus", "browserFocus"]);
    let composer = when(&["promptAvailable"], &["modalOpen", "terminalFocus", "browserFocus"]);

    let mut bindings = vec![
        bind("palette.open", Some("mod+shift+p"), &main),
        bind("thread.new", Some("mod+shift+o"), &main),
        bind("thread.search", Some("mod+k"), &main),
        bind("thread.rename", None, &main),
        bind("thread.archive", None, &main),
        bind("app.back", Some("Escape"), &main),
        bind("settings.open", Some("mod+,"), &main),
        bind("sidebar.toggle", Some("mod+\\"), &main),
        bind("thread.previous", Some("control+shift+["), &web_main),
        bind("thread.next", Some("control+shift+]"), &web_main),
    ];
    bindings.extend(numbered(&THREAD_JUMP_APP_COMMAND_IDS, &main));
    bindings.extend(mac_only("pane.focus.left", "mod+control+shift+ArrowLeft", &split));
    bindings.extend(mac_only("pane.focus.right", "mod+control+shift+ArrowRight", &split));
    bindings.extend(mac_only("pane.focus.up", "mod+control+shift+ArrowUp", &split));
    bindings.extend(mac_only("pane.focus.down", "mod+control+shift+ArrowDown", &split));
    bindings.push(bind("pane.focus.previous", None, &split));
    bindings.push(bind("pane.focus.next", None, &split));
    bindings.extend(numbered(&PANE_FOCUS_APP_COMMAND_IDS, &split));
    bindings.push(bind("pane.maximize.toggle", Some("mod+shift+e"), &split));
    bindings.push(bind("pane.close", Some("mod+shift+x"), &split));
    bindings.extend(mac_only("panel.previousTab", "mod+control+ArrowLeft", &main));
    bindings.extend(mac_only("panel.nextTab", "mod+control+ArrowRight", &main));
    bindings.extend(mac_only("panel.previousNewTabItem", "mod+control+ArrowUp", &main));
    bindings.extend(mac_only("panel.nextNewTabItem", "mod+control+ArrowDown", &main));
    bindings.extend([
        bind("panel.newTab", Some("mod+t"), &main),
        bind("panel.close", Some("mod+w"), &main),
        bind("panel.toggle", Some("mod+j"), &main),
        bind("file.quickOpen", Some("mod+p"), &main),
        bind("diff.toggle", Some("mod+d"), &outside_editors),
        bind("terminal.open", Some("mod+shift+Enter"), &main),
        bind("composer.focus", Some("mod+shift+c"), &composer),
        bind("modelPicker.toggle", Some("mod+shift+m"), &composer),
        bind("modelPicker.toggle", Some("mod+shift+m"), &picker_open),
    ]);
    bindings.extend(model_picker(&composer));
    bindings.extend(model_picker(&picker_open));
    bindings.push(bind("workspace.openPreferred", Some("mod+o"), &main));
    bindings.extend(
        QUESTION_SELECT_APP_COMMAND_IDS
            .iter()
            .enumerate()
            .map(|(index, command)| bind(command, Some(&(index + 1).to_string()), &question)),
    );
    bindings
}

/// `DEFAULT_APP_KEYBINDINGS`.
pub static DEFAULT_APP_KEYBINDINGS: LazyLock<Vec<AppDefaultKeybinding>> =
    LazyLock::new(default_app_keybindings);

fn platform_context(platform: KeyboardPlatform) -> &'static str {
    match platform {
        KeyboardPlatform::Mac => "macPlatform",
        KeyboardPlatform::Windows => "windowsPlatform",
        KeyboardPlatform::Linux => "linuxPlatform",
    }
}

/// `findAppKeybindingOverride`: the platform-specific override, else the one for every platform.
pub fn find_app_keybinding_override<'a>(
    overrides: &'a [AppKeybindingOverride],
    command: &str,
    platform: KeyboardPlatform,
) -> Option<&'a AppKeybindingOverride> {
    overrides
        .iter()
        .find(|item| item.command == command && item.platform == Some(platform))
        .or_else(|| {
            overrides.iter().find(|item| item.command == command && item.platform.is_none())
        })
}

fn with_shortcut(
    binding: &AppDefaultKeybinding,
    shortcut: Option<&AppShortcut>,
    when: AppCommandWhen,
) -> Option<AppKeybinding> {
    let shortcut = shortcut.cloned()?;
    Some(AppKeybinding { command: binding.command.clone(), shortcut, when })
}

/// `applyAppKeybindingOverrides`: the effective bindings, with platform-specific overrides
/// splitting a binding into one per platform.
pub fn apply_app_keybinding_overrides(
    defaults: &[AppDefaultKeybinding],
    overrides: &[AppKeybindingOverride],
) -> Vec<AppKeybinding> {
    defaults
        .iter()
        .flat_map(|binding| {
            let per_platform = overrides
                .iter()
                .any(|item| item.command == binding.command && item.platform.is_some());
            if !per_platform {
                let found = overrides.iter().find(|item| item.command == binding.command);
                let shortcut =
                    found.map_or(binding.shortcut.as_ref(), |item| item.shortcut.as_ref());
                return with_shortcut(binding, shortcut, binding.when.clone())
                    .into_iter()
                    .collect::<Vec<_>>();
            }
            PLATFORMS
                .iter()
                .filter_map(|&platform| {
                    let context = platform_context(platform);
                    let other_only = PLATFORMS.iter().any(|&other| {
                        other != platform && binding.when.all.contains(&platform_context(other))
                    });
                    if binding.when.none.contains(&context) || other_only {
                        return None;
                    }
                    let found = find_app_keybinding_override(overrides, &binding.command, platform);
                    let shortcut =
                        found.map_or(binding.shortcut.as_ref(), |item| item.shortcut.as_ref());
                    let mut when = binding.when.clone();
                    if !when.all.contains(&context) {
                        when.all.push(context);
                    }
                    with_shortcut(binding, shortcut, when)
                })
                .collect()
        })
        .collect()
}

/// `appKeybindingOverridesSchema`: at most 1024 overrides of known commands, one per command
/// and platform. The error is the request's `invalid_request` message.
pub fn parse_app_keybinding_overrides(value: &Value) -> Result<AppKeybindingOverrides, String> {
    let items = value.as_array().ok_or("Expected an array of keybinding overrides")?;
    if items.len() > MAX_OVERRIDES {
        return Err(format!("At most {MAX_OVERRIDES} keybinding overrides are allowed"));
    }
    let mut overrides: AppKeybindingOverrides = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let parsed = parse_app_keybinding_override(item)
            .ok_or_else(|| format!("Invalid keybinding override at index {index}"))?;
        let duplicate = overrides
            .iter()
            .any(|seen| seen.command == parsed.command && seen.platform == parsed.platform);
        if duplicate {
            return Err(format!("Duplicate override for {}", parsed.command));
        }
        overrides.push(parsed);
    }
    Ok(overrides)
}
