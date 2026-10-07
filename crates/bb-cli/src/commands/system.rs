use crate::call::{Handler, not_implemented};

/// Handlers ported from `apps/cli/src/commands/system.ts`.
pub fn handlers() -> Vec<(&'static str, Handler)> {
    vec![
        ("status", not_implemented),
        ("guide", crate::guide::guide),
        ("fileRead", not_implemented),
        ("fileWrite", not_implemented),
        ("fileList", not_implemented),
        ("settingsShow", not_implemented),
        ("pluginList", not_implemented),
        ("pluginReload", not_implemented),
        ("pluginAdd", not_implemented),
        ("pluginRemove", not_implemented),
        ("server", not_implemented),
        ("importLegacy", not_implemented),
        ("serverStatus", not_implemented),
        ("runnerJoin", not_implemented),
        ("runnerRun", not_implemented),
        ("settingsSet", not_implemented),
        ("settingsReset", not_implemented),
        ("settingsGet", not_implemented),
        ("pluginEnable", not_implemented),
        ("pluginDisable", not_implemented),
    ]
}
