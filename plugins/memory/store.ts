import { randomBytes } from "node:crypto";
import { PluginCliError, type PluginServerApi } from "@bb/plugin";
import { z } from "zod";
import {
  MEMORY_KINDS,
  type MemoryKind,
  type MemoryRecord,
} from "./contract.js";

export type MemoryScope = "global" | "project";
export type ReadScope = MemoryScope | "all";
type Database = ReturnType<PluginServerApi["storage"]["database"]>;

export interface MemoryCreate {
  scope: MemoryScope;
  projectId: string | null;
  name: string;
  summary: string;
  details: string;
  kind: MemoryKind;
  tags: string[];
  importance: number;
  pinned: boolean;
  sourceThreadId: string | null;
  writeReason: string;
}

export interface MemoryUpdate {
  expectedVersion: number;
  summary?: string;
  details?: string;
  kind?: MemoryKind;
  tags?: string[];
  importance?: number;
  pinned?: boolean;
  sourceThreadId: string | null;
  writeReason: string;
}

export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS memories (
     id TEXT PRIMARY KEY,
     scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
     scope_key TEXT NOT NULL,
     project_id TEXT,
     name TEXT NOT NULL,
     summary TEXT NOT NULL,
     details TEXT NOT NULL,
     kind TEXT NOT NULL,
     tags_json TEXT NOT NULL,
     importance INTEGER NOT NULL CHECK (importance BETWEEN 0 AND 100),
     pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
     source_thread_id TEXT,
     write_reason TEXT NOT NULL,
     version INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     deleted_at INTEGER,
     last_accessed_at INTEGER,
     access_count INTEGER NOT NULL DEFAULT 0,
     CHECK ((scope = 'global' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
   );
   CREATE UNIQUE INDEX IF NOT EXISTS memories_active_scope_name
     ON memories(scope_key, name) WHERE deleted_at IS NULL;
   CREATE INDEX IF NOT EXISTS memories_catalog
     ON memories(scope, project_id, deleted_at, pinned, importance, updated_at);
   CREATE TABLE IF NOT EXISTS memory_history (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     memory_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     action TEXT NOT NULL CHECK (action IN ('create', 'update', 'forget')),
     snapshot_json TEXT NOT NULL,
     source_thread_id TEXT,
     write_reason TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE(memory_id, version)
   );
   CREATE INDEX IF NOT EXISTS memory_history_memory
     ON memory_history(memory_id, version DESC);
   CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
     memory_id UNINDEXED, name, summary, details, tags
   );
   CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
     INSERT INTO memories_fts(memory_id, name, summary, details, tags)
     VALUES (new.id, new.name, new.summary, new.details, new.tags_json);
   END;
   CREATE TRIGGER IF NOT EXISTS memories_fts_update
     AFTER UPDATE OF name, summary, details, tags_json ON memories BEGIN
     DELETE FROM memories_fts WHERE memory_id = old.id;
     INSERT INTO memories_fts(memory_id, name, summary, details, tags)
     VALUES (new.id, new.name, new.summary, new.details, new.tags_json);
   END;
   CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
     DELETE FROM memories_fts WHERE memory_id = old.id;
   END;`,
];

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;

const tagList = z.string().transform((raw): string[] => {
  const parsed = z.array(z.string()).safeParse(
    (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return [];
      }
    })(),
  );
  return parsed.success ? parsed.data : [];
});

const memoryRow = z
  .object({
    id: z.string(),
    scope: z.enum(["global", "project"]),
    project_id: z.string().nullable(),
    name: z.string(),
    summary: z.string(),
    details: z.string(),
    kind: z.string(),
    tags_json: tagList,
    importance: z.number(),
    pinned: z.number(),
    source_thread_id: z.string().nullable(),
    write_reason: z.string(),
    version: z.number(),
    created_at: z.number(),
    updated_at: z.number(),
  })
  .transform((row): MemoryRecord => ({
    id: row.id,
    scope: row.scope,
    projectId: row.project_id,
    name: row.name,
    summary: row.summary,
    details: row.details,
    kind: MEMORY_KINDS.find((kind) => kind === row.kind) ?? "fact",
    tags: row.tags_json,
    importance: row.importance,
    pinned: row.pinned === 1,
    sourceThreadId: row.source_thread_id,
    writeReason: row.write_reason,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

const historyRow = z.object({
  version: z.number(),
  action: z.string(),
  snapshot_json: z.string(),
  source_thread_id: z.string().nullable(),
  write_reason: z.string(),
  created_at: z.number(),
});

const fail = (message: string): never => {
  throw new PluginCliError(message);
};

function unsafeMemoryReason(value: string): string | null {
  if (/[​-‏‪-‮⁠﻿]/u.test(value)) {
    return "contains invisible or bidirectional control characters";
  }
  if (/<\/?\s*(system|developer|assistant|tool)(?:\s|>)/iu.test(value)) {
    return "contains a role-like prompt tag";
  }
  if (
    /\b(ignore|disregard|override)\b.{0,50}\b(previous|prior|system|developer)\b/isu.test(
      value,
    )
  ) {
    return "looks like a prompt-injection instruction";
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value)) {
    return "contains a private key";
  }
  if (/\b(?:sk-[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{20,})\b/iu.test(value)) {
    return "contains a token-like secret";
  }
  if (/\b[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY)\s*=\s*\S+/u.test(value)) {
    return "contains a credential assignment";
  }
  return null;
}

function validateText(label: string, value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) fail(`${label} must not be empty`);
  if (trimmed.length > maxChars) {
    fail(`${label} must be at most ${maxChars} characters`);
  }
  const unsafe = unsafeMemoryReason(trimmed);
  if (unsafe) fail(`${label} ${unsafe}; memory was not written`);
  return trimmed;
}

function validateName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!NAME_PATTERN.test(normalized)) {
    fail(
      "name must be 1-80 lowercase letters, digits, dots, underscores, or hyphens",
    );
  }
  return normalized;
}

function validateTags(values: string[]): string[] {
  const tags = [...new Set(values.map((tag) => tag.trim().toLowerCase()))];
  if (tags.length > 20) fail("at most 20 tags are allowed");
  for (const tag of tags) {
    if (!TAG_PATTERN.test(tag)) {
      fail(
        `invalid tag "${tag}"; use lowercase letters, digits, dots, underscores, or hyphens`,
      );
    }
  }
  return tags;
}

function scopeSql(scope: ReadScope, projectId: string | undefined) {
  if (scope === "global") return { sql: "m.scope = 'global'", params: [] };
  if (scope === "project") {
    if (!projectId) fail("project scope requires a BB project context");
    return {
      sql: "m.scope = 'project' AND m.project_id = ?",
      params: [projectId],
    };
  }
  if (!projectId) return { sql: "m.scope = 'global'", params: [] };
  return {
    sql: "(m.scope = 'global' OR (m.scope = 'project' AND m.project_id = ?))",
    params: [projectId],
  };
}

function searchExpression(query: string): string {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (tokens.length === 0) fail("search query has no searchable terms");
  return [...new Set(tokens)]
    .slice(0, 12)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" OR ");
}

export function memoryStore(db: Database, now: () => number) {
  const rows = (sql: string, ...params: unknown[]): MemoryRecord[] =>
    z.array(memoryRow).parse(db.prepare(sql).all(...params));
  const row = (sql: string, ...params: unknown[]): MemoryRecord | null => {
    const found: unknown = db.prepare(sql).get(...params);
    return found === undefined ? null : memoryRow.parse(found);
  };
  const history = (
    memory: MemoryRecord,
    action: "create" | "update" | "forget",
  ): void => {
    db.prepare(
      `INSERT INTO memory_history (
         memory_id, version, action, snapshot_json, source_thread_id, write_reason, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      memory.id,
      memory.version,
      action,
      JSON.stringify(memory),
      memory.sourceThreadId,
      memory.writeReason,
      memory.updatedAt,
    );
  };

  const get = (
    idOrName: string,
    scope: ReadScope,
    projectId: string | undefined,
    touch = true,
  ): MemoryRecord | null => {
    const scoped = scopeSql(scope, projectId);
    const memory = row(
      `SELECT m.* FROM memories m
       WHERE m.deleted_at IS NULL AND (m.id = ? OR m.name = ?) AND ${scoped.sql}
       ORDER BY CASE WHEN m.scope = 'project' THEN 0 ELSE 1 END, m.updated_at DESC
       LIMIT 1`,
      idOrName,
      idOrName,
      ...scoped.params,
    );
    if (memory && touch) {
      db.prepare("UPDATE memories SET last_accessed_at = ? WHERE id = ?").run(
        now(),
        memory.id,
      );
    }
    return memory;
  };

  const current = (
    id: string,
    expectedVersion: number,
    projectId: string | undefined,
  ): MemoryRecord => {
    const memory =
      get(id, "all", projectId, false) ??
      fail(`memory "${id}" was not found in the current scope`);
    if (memory.version !== expectedVersion) {
      fail(
        `version conflict for ${id}: expected ${expectedVersion}, current ${memory.version}`,
      );
    }
    return memory;
  };

  return {
    get,

    add(input: MemoryCreate): MemoryRecord {
      const at = now();
      const record: MemoryRecord = {
        ...input,
        id: `mem_${randomBytes(8).toString("base64url").toLowerCase()}`,
        name: validateName(input.name),
        summary: validateText("summary", input.summary, 400),
        details: validateText("details", input.details, 16_000),
        tags: validateTags(input.tags),
        writeReason: validateText("reason", input.writeReason, 500),
        version: 1,
        createdAt: at,
        updatedAt: at,
      };
      const scopeKey =
        record.scope === "global" ? "global" : `project:${record.projectId}`;
      try {
        db.transaction(() => {
          db.prepare(
            `INSERT INTO memories (
               id, scope, scope_key, project_id, name, summary, details, kind,
               tags_json, importance, pinned, source_thread_id, write_reason,
               version, created_at, updated_at, deleted_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          ).run(
            record.id,
            record.scope,
            scopeKey,
            record.projectId,
            record.name,
            record.summary,
            record.details,
            record.kind,
            JSON.stringify(record.tags),
            record.importance,
            record.pinned ? 1 : 0,
            record.sourceThreadId,
            record.writeReason,
            record.version,
            record.createdAt,
            record.updatedAt,
          );
          history(record, "create");
        })();
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("UNIQUE constraint failed")
        ) {
          fail(
            `an active ${record.scope} memory named "${record.name}" already exists`,
          );
        }
        throw error;
      }
      return record;
    },

    update(
      id: string,
      input: MemoryUpdate,
      projectId: string | undefined,
    ): MemoryRecord {
      return db.transaction(() => {
        const was = current(id, input.expectedVersion, projectId);
        const text = (label: string, value: string | undefined, max: number) =>
          value === undefined ? undefined : validateText(label, value, max);
        const updated: MemoryRecord = {
          ...was,
          summary: text("summary", input.summary, 400) ?? was.summary,
          details: text("details", input.details, 16_000) ?? was.details,
          kind: input.kind ?? was.kind,
          tags: input.tags === undefined ? was.tags : validateTags(input.tags),
          importance: input.importance ?? was.importance,
          pinned: input.pinned ?? was.pinned,
          sourceThreadId: input.sourceThreadId,
          writeReason: validateText("reason", input.writeReason, 500),
          version: was.version + 1,
          updatedAt: now(),
        };
        const result = db
          .prepare(
            `UPDATE memories SET
               summary = ?, details = ?, kind = ?, tags_json = ?, importance = ?,
               pinned = ?, source_thread_id = ?, write_reason = ?, version = ?, updated_at = ?
             WHERE id = ? AND version = ? AND deleted_at IS NULL`,
          )
          .run(
            updated.summary,
            updated.details,
            updated.kind,
            JSON.stringify(updated.tags),
            updated.importance,
            updated.pinned ? 1 : 0,
            updated.sourceThreadId,
            updated.writeReason,
            updated.version,
            updated.updatedAt,
            updated.id,
            was.version,
          );
        if (result.changes !== 1)
          fail(`memory ${id} changed concurrently; retry`);
        history(updated, "update");
        return updated;
      })();
    },

    forget(
      id: string,
      expectedVersion: number,
      reason: string,
      sourceThreadId: string | null,
      projectId: string | undefined,
    ): MemoryRecord {
      return db.transaction(() => {
        const was = current(id, expectedVersion, projectId);
        const forgotten: MemoryRecord = {
          ...was,
          sourceThreadId,
          writeReason: validateText("reason", reason, 500),
          version: was.version + 1,
          updatedAt: now(),
        };
        const result = db
          .prepare(
            `UPDATE memories SET deleted_at = ?, source_thread_id = ?, write_reason = ?,
               version = ?, updated_at = ?
             WHERE id = ? AND version = ? AND deleted_at IS NULL`,
          )
          .run(
            forgotten.updatedAt,
            sourceThreadId,
            forgotten.writeReason,
            forgotten.version,
            forgotten.updatedAt,
            id,
            was.version,
          );
        if (result.changes !== 1)
          fail(`memory ${id} changed concurrently; retry`);
        history(forgotten, "forget");
        return forgotten;
      })();
    },

    list(scope: ReadScope, projectId: string | undefined, limit: number) {
      const scoped = scopeSql(scope, projectId);
      const memories = rows(
        `SELECT m.* FROM memories m
         WHERE m.deleted_at IS NULL AND ${scoped.sql}
         ORDER BY m.pinned DESC,
           CASE WHEN m.scope = 'project' THEN 0 ELSE 1 END,
           m.importance DESC, COALESCE(m.last_accessed_at, 0) DESC,
           m.updated_at DESC, m.name ASC
         LIMIT ?`,
        ...scoped.params,
        limit,
      );
      const count = z.object({ count: z.number() }).parse(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM memories m
             WHERE m.deleted_at IS NULL AND ${scoped.sql}`,
          )
          .get(...scoped.params),
      );
      return { memories, total: count.count };
    },

    listAll(): MemoryRecord[] {
      return rows(
        `SELECT * FROM memories WHERE deleted_at IS NULL
         ORDER BY pinned DESC, scope ASC, project_id ASC, importance DESC,
           updated_at DESC, name ASC`,
      );
    },

    getAdmin(id: string): MemoryRecord | null {
      return row(
        "SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL",
        id,
      );
    },

    search(
      query: string,
      scope: ReadScope,
      projectId: string | undefined,
      limit: number,
    ): MemoryRecord[] {
      const scoped = scopeSql(scope, projectId);
      return rows(
        `SELECT m.* FROM memories_fts f
         JOIN memories m ON m.id = f.memory_id
         WHERE memories_fts MATCH ? AND m.deleted_at IS NULL AND ${scoped.sql}
         ORDER BY bm25(memories_fts), m.pinned DESC, m.importance DESC, m.updated_at DESC
         LIMIT ?`,
        searchExpression(query),
        ...scoped.params,
        limit,
      );
    },

    history(id: string, projectId: string | undefined, limit: number) {
      const scoped = scopeSql("all", projectId);
      return z.array(historyRow).parse(
        db
          .prepare(
            `SELECT h.version, h.action, h.snapshot_json, h.source_thread_id,
               h.write_reason, h.created_at
             FROM memory_history h
             JOIN memories m ON m.id = h.memory_id
             WHERE h.memory_id = ? AND ${scoped.sql}
             ORDER BY h.version DESC
             LIMIT ?`,
          )
          .all(id, ...scoped.params, limit),
      );
    },
  };
}

export type MemoryStore = ReturnType<typeof memoryStore>;
