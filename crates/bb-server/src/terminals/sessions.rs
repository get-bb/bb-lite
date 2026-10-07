//! Terminal sessions: the server's record of each PTY on a machine and the
//! WebSocket that carries its bytes. The port of
//! `apps/server/src/terminals/sessions.ts`.

use crate::context::Ctx;

/// In-memory terminal state (attached sockets, replay cursors).
#[derive(Default)]
pub struct TerminalsState {}

/// Closes every open terminal of a thread (`owner` = `"thread_id"`) or an
/// environment (`"environment_id"`); `reason` is a `TerminalSessionCloseReason` string.
pub fn close_terminals_for(_ctx: &Ctx, _owner: &str, _owner_id: &str, _reason: &str) {
    todo!("terminals port")
}
