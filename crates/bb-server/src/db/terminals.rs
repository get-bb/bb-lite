#![allow(clippy::result_large_err)]

use rusqlite::Params;

use super::{Db, DbResult, OnConflict, RowValues, insert_row, new_id, update_row};
use crate::domain::terminal::{TerminalSession, TerminalSessionStatus};
use crate::error::{ApiError, ApiResult};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewTerminal {
    pub thread_id: Option<String>,
    pub environment_id: Option<String>,
    pub host_id: String,
    pub title: String,
    pub initial_cwd: String,
    pub cols: i64,
    pub rows: i64,
}

const TERMINAL_COLUMNS: &str = "id, thread_id, environment_id, host_id, title,
  initial_cwd, cols, rows, status, exit_code, close_reason, created_at,
  updated_at, last_user_input_at";

/// Sessions matching the SQL condition `where_clause`, oldest first.
pub fn select_terminals(
    db: &Db,
    where_clause: &str,
    params: impl Params,
) -> DbResult<Vec<TerminalSession>> {
    let sql = format!(
        "SELECT {TERMINAL_COLUMNS} FROM terminal_sessions WHERE {where_clause}
     ORDER BY created_at, id"
    );
    db.all(&sql, params)
}

pub fn get_terminal(db: &Db, id: &str) -> DbResult<Option<TerminalSession>> {
    Ok(select_terminals(db, "id = ?", [id])?.into_iter().next())
}

pub fn insert_terminal(db: &Db, terminal: &NewTerminal) -> ApiResult<TerminalSession> {
    let id = new_id("term");
    let row = crate::row! {
        "id" => &id,
        "threadId" => terminal.thread_id.as_deref(),
        "environmentId" => terminal.environment_id.as_deref(),
        "hostId" => &terminal.host_id,
        "title" => &terminal.title,
        "initialCwd" => &terminal.initial_cwd,
        "cols" => terminal.cols,
        "rows" => terminal.rows,
        "status" => TerminalSessionStatus::Starting.as_str(),
        "createdAt" => db.now(),
        "updatedAt" => db.now(),
    };
    insert_row(db, "terminal_sessions", &row, OnConflict::Fail)?;
    get_terminal(db, &id)?.ok_or_else(|| ApiError::internal("Terminal session was not stored"))
}

pub fn update_terminal(db: &Db, id: &str, patch: &RowValues) -> DbResult<Option<TerminalSession>> {
    update_row(db, "terminal_sessions", id, patch, true)?;
    get_terminal(db, id)
}
