use crate::call::{Handler, not_implemented};

/// Handlers ported from `apps/cli/src/commands/terminal.ts`.
pub fn handlers() -> Vec<(&'static str, Handler)> {
    vec![
        ("terminalCreate", not_implemented),
        ("terminalList", not_implemented),
        ("terminalOutput", not_implemented),
        ("terminalWait", not_implemented),
        ("terminalSend", not_implemented),
        ("terminalClose", not_implemented),
    ]
}
