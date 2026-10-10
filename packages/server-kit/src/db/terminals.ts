import type { TerminalSession } from "@bb/server-contract";
import {
  insertRow,
  newId,
  updateRow,
  type Db,
  type RowValues,
  type SqlValue,
} from "./index.js";

export type NewTerminal = Pick<
  TerminalSession,
  | "threadId"
  | "environmentId"
  | "hostId"
  | "title"
  | "initialCwd"
  | "cols"
  | "rows"
>;

const TERMINAL_COLUMNS = `id, thread_id, environment_id, host_id, title,
  initial_cwd, cols, rows, status, exit_code, close_reason, created_at,
  updated_at, last_user_input_at`;

export function selectTerminals(
  db: Db,
  where: string,
  ...params: SqlValue[]
): TerminalSession[] {
  return db.all<TerminalSession>(
    `SELECT ${TERMINAL_COLUMNS} FROM terminal_sessions WHERE ${where}
     ORDER BY created_at, id`,
    ...params,
  );
}

export function getTerminal(db: Db, id: string): TerminalSession | undefined {
  return selectTerminals(db, "id = ?", id)[0];
}

export function insertTerminal(db: Db, terminal: NewTerminal): TerminalSession {
  const id = newId("term");
  const at = { createdAt: db.now(), updatedAt: db.now() };
  const row = { id, ...terminal, status: "starting", ...at };
  insertRow(db, "terminal_sessions", row);
  const stored = getTerminal(db, id);
  if (stored === undefined) throw new Error("Terminal session was not stored");
  return stored;
}

export function updateTerminal(
  db: Db,
  id: string,
  patch: RowValues,
): TerminalSession | undefined {
  updateRow(db, "terminal_sessions", id, patch);
  return getTerminal(db, id);
}
