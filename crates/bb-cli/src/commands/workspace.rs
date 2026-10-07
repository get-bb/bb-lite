use crate::call::{Handler, not_implemented};

/// Handlers ported from `apps/cli/src/commands/workspace.ts`.
pub fn handlers() -> Vec<(&'static str, Handler)> {
    vec![
        ("projectList", not_implemented),
        ("projectShow", not_implemented),
        ("projectCreate", not_implemented),
        ("projectUpdate", not_implemented),
        ("projectDelete", not_implemented),
        ("projectSourceAdd", not_implemented),
        ("projectSourceUpdate", not_implemented),
        ("projectSourceDelete", not_implemented),
        ("projectAttachmentUpload", not_implemented),
        ("envList", not_implemented),
        ("envShow", not_implemented),
        ("envStatus", not_implemented),
        ("envCommit", not_implemented),
        ("envUpdate", not_implemented),
        ("envDelete", not_implemented),
        ("machineList", not_implemented),
        ("machineShow", not_implemented),
        ("machineAdd", not_implemented),
        ("machineReconnect", not_implemented),
        ("machineRename", not_implemented),
        ("machineRemove", not_implemented),
        ("machineEnvList", not_implemented),
        ("machineEnvSet", not_implemented),
        ("machineEnvUnset", not_implemented),
        ("providerList", not_implemented),
        ("providerModels", not_implemented),
        ("providerEnable", not_implemented),
        ("providerDisable", not_implemented),
    ]
}
