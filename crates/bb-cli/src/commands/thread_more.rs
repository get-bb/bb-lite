use crate::call::{Handler, not_implemented};

/// Handlers ported from `apps/cli/src/commands/thread-more.ts`.
pub fn handlers() -> Vec<(&'static str, Handler)> {
    vec![
        ("threadInteractionsList", not_implemented),
        ("threadInteractionsShow", not_implemented),
        ("threadInteractionsResolve", not_implemented),
        ("threadQueueList", not_implemented),
        ("threadQueueSend", not_implemented),
        ("threadQueueDelete", not_implemented),
        ("threadSectionList", not_implemented),
        ("threadSectionCreate", not_implemented),
        ("threadSectionRename", not_implemented),
        ("threadSectionDelete", not_implemented),
    ]
}
