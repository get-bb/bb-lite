import type { AuditEntry, AuditRecord } from "@bb/plugin";
import { insertRow, type Db } from "./index.js";

interface AuditRow {
  id: number;
  at: number;
  op: string;
  kind: string;
  userId: string | null;
  role: string;
  door: string;
  threadId: string | null;
  via: string;
  hooks: string;
  outcome: string;
  detail: string | null;
  durationMs: number;
  input: string | null;
}

export interface AuditQuery {
  userId?: string;
  op?: string;
  threadId?: string;
  plugin?: string;
  before?: number;
  limit: number;
}

export function recordAudit(db: Db, entry: AuditRecord): void {
  const { caller, at, op, kind, outcome, detail, durationMs, input } = entry;
  insertRow(db, "audit_log", {
    at,
    op,
    kind,
    userId: caller.user,
    role: caller.role,
    door: caller.door,
    threadId: caller.thread,
    via: JSON.stringify(
      caller.app === undefined
        ? caller.via
        : [`app:${caller.app}`, ...caller.via],
    ),
    hooks: JSON.stringify(entry.hooks),
    outcome,
    detail,
    durationMs,
    input,
  });
}

export function pruneAudit(db: Db, before: number): number {
  return db.run("DELETE FROM audit_log WHERE at < ?", before).changes;
}

export function listAudit(db: Db, query: AuditQuery): AuditEntry[] {
  const { userId, op, threadId, plugin, before, limit } = query;
  const named = plugin === undefined ? undefined : `%"${plugin}"%`;
  const filters: [clause: string, value: string | number | undefined][] = [
    ["user_id = ?", userId],
    ["op = ?", op],
    ["thread_id = ?", threadId],
    ["id < ?", before],
    ["(via LIKE ? OR hooks LIKE ?)", named],
  ];
  const active = filters.filter(([, value]) => value !== undefined);
  const where = active.map(([clause]) => clause).join(" AND ");
  const params = active.flatMap(([clause, value]) =>
    clause.startsWith("(") ? [value, value] : [value],
  );
  const rows = db.all<AuditRow>(
    `SELECT * FROM audit_log ${where === "" ? "" : `WHERE ${where}`}
     ORDER BY id DESC LIMIT ?`,
    ...(params as (string | number)[]),
    limit,
  );
  return rows.map((row) => ({
    ...row,
    via: JSON.parse(row.via) as string[],
    hooks: JSON.parse(row.hooks) as AuditEntry["hooks"],
  }));
}
