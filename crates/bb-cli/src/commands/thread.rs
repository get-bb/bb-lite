use crate::call::{Handler, not_implemented};

/// Handlers ported from `apps/cli/src/commands/thread.ts`.
pub fn handlers() -> Vec<(&'static str, Handler)> {
    vec![
        ("threadSpawn", not_implemented),
        ("threadTell", not_implemented),
        ("threadWait", not_implemented),
        ("threadShow", not_implemented),
        ("threadLog", not_implemented),
        ("threadOutput", not_implemented),
        ("threadList", not_implemented),
        ("threadUpdate", not_implemented),
        ("threadDelete", not_implemented),
        ("threadSearch", not_implemented),
        ("threadOpen", not_implemented),
        ("threadStop", not_implemented),
        ("threadArchive", not_implemented),
        ("threadUnarchive", not_implemented),
        ("threadCompact", not_implemented),
        ("threadClear", not_implemented),
        ("threadPin", not_implemented),
        ("threadUnpin", not_implemented),
        ("threadRead", not_implemented),
        ("threadUnread", not_implemented),
    ]
}
