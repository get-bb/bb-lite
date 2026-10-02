import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appSettingsSchema } from "@bb/domain";
import Database from "better-sqlite3";
import { z } from "zod";
import { dataPaths, loadConfig, loopbackUrl } from "./config.js";
import type { ServerConfig, ServerEnv } from "./config.js";
import { openDatabase, type Db, type SqlValue } from "./db/index.js";

type Row = Record<string, SqlValue>;
type Legacy = Database.Database;
type Add = (table: string, row: Row) => void;
type Numbers = Record<string, number>;
export type ThreadChoice = "active" | "all" | "none";
export type ImportLegacySummary = Awaited<ReturnType<typeof importLegacy>>;

export interface ImportLegacyOptions {
  from: string;
  threads: ThreadChoice;
  dryRun: boolean;
  env?: ServerEnv;
}

const DELTA_TYPE = /\/(delta|textDelta|summaryTextDelta|outputDelta)$/u;
const SERVER_PROBE_MS = 2_000;
const NOT_IMPORTED =
  "plugin data (tasks, account pool accounts, secrets), automations, " +
  "attachments, terminals, queued messages, right-panel tabs, provider " +
  "logins (Codex and Claude Code keep their own), machine credentials " +
  "(other machines stay offline until `bb machine reconnect <name>`)";
const GENERAL_KEYS = Object.keys(appSettingsSchema.shape).join("', '");
const CHOSEN: Record<ThreadChoice, string> = {
  active: `deleted_at IS NULL AND id IN (
    WITH RECURSIVE
      live (id) AS (SELECT id FROM threads
        WHERE archived_at IS NULL AND deleted_at IS NULL),
      up (id) AS (SELECT id FROM live UNION SELECT t.parent_thread_id
        FROM threads t JOIN up ON t.id = up.id),
      down (id) AS (SELECT id FROM live UNION SELECT t.id
        FROM threads t JOIN down ON t.parent_thread_id = down.id)
    SELECT id FROM up UNION SELECT id FROM down)`,
  all: "deleted_at IS NULL",
  none: "0",
};
const HOSTS = `SELECT id, name, type, max_permission_mode, destroyed_at,
  created_at, updated_at, IIF(destroyed_at IS NULL, 'active', 'destroyed')
  AS phase FROM hosts ORDER BY created_at, id`;
const PROJECTS = `SELECT *, (SELECT json_object('providerId', provider_id,
    'model', model, 'serviceTier', service_tier, 'reasoningLevel',
    reasoning_level, 'permissionMode', permission_mode)
  FROM project_execution_defaults WHERE project_id = projects.id)
  AS execution_defaults FROM projects`;
const ENVIRONMENTS = `SELECT *, NULL AS environment_provider_selection,
  IIF(status = 'destroyed', provider_owns_path, 0) AS provider_owns_path,
  NULL AS retire_at, NULL AS teardown_status, 0 AS teardown_attempt,
  NULL AS teardown_message FROM environments
  WHERE id IN (SELECT environment_id FROM threads WHERE `;
const THREADS = `SELECT *, IIF(status = 'error', 'error', 'idle') AS status,
  NULL AS startup_context, IIF(origin_kind = 'fork', 'fork', NULL)
  AS origin_kind FROM threads WHERE `;
const THREAD_LINKS = {
  environment_id: "environments",
  section_id: "thread_sections",
  parent_thread_id: "threads",
  source_thread_id: "threads",
  lifecycle_owner_thread_id: "threads",
};
const SIDEBAR_PREFERENCES = `SELECT * FROM plugin_kv
  WHERE plugin_id = 'thread-list' AND key LIKE 'preference:%'`;
const SETTINGS = `SELECT key, value, updated_at FROM app_settings_values
    WHERE key IN ('keybindingOverrides', 'disabledProviderIds')
  UNION ALL SELECT 'general', json_group_object(key, json(value)),
    MAX(updated_at) FROM app_settings_values
    WHERE key IN ('${GENERAL_KEYS}') HAVING COUNT(*) > 0
  UNION ALL SELECT 'appearance', json_object('themeId', theme_id,
    'faviconColor', favicon_color), updated_at
    FROM app_theme WHERE id = 'current'`;
const RESTORE_SESSION = `UPDATE threads SET
  provider_thread_id = (SELECT provider_thread_id FROM events
    WHERE thread_id = @id AND type = 'thread/identity' AND sequence > COALESCE(
      (SELECT MAX(sequence) FROM events WHERE thread_id = @id
        AND type = 'system/operation' AND data ->> '$.status' = 'completed'
        AND data ->> '$.operation' = 'context_clear'), 0)
    ORDER BY sequence DESC LIMIT 1),
  (model, reasoning_level, permission_mode, service_tier) = (
    SELECT data ->> '$.execution.model', data ->> '$.execution.reasoningLevel',
      data ->> '$.execution.permissionMode', data ->> '$.execution.serviceTier'
    FROM events WHERE thread_id = @id AND type = 'client/turn/requested'
    ORDER BY sequence DESC LIMIT 1)
  WHERE id = @id`;
const EMPTY_THREAD = `SELECT 1 FROM threads WHERE id = ?
  AND NOT EXISTS (SELECT 1 FROM events WHERE thread_id = threads.id)`;
const SETTLED = "status NOT IN ('pending', 'resolving')";
const THREAD_CONTENT = {
  prompt_history_entries: "",
  thread_search_segments: "",
  pending_interactions: `, IIF(${SETTLED}, status, 'interrupted') AS status,
    IIF(${SETTLED}, status_reason, 'thread-stopped') AS status_reason,
    COALESCE(resolved_at, updated_at) AS resolved_at`,
};

function rows(legacy: Legacy, sql: string, ...params: SqlValue[]): Row[] {
  return legacy.prepare(sql).all(...params) as Row[];
}

function eventCount(legacy: Legacy, threads: Row[]): number {
  const sql = "SELECT COUNT(*) AS stored FROM events WHERE thread_id = ?";
  const count = (id: SqlValue) => Number(rows(legacy, sql, id)[0]?.stored);
  return threads.reduce((sum, thread) => sum + count(thread.id ?? null), 0);
}

async function refuseRunningServer(config: ServerConfig): Promise<void> {
  const url = `${loopbackUrl(config)}/api/v1/system/config`;
  const signal = AbortSignal.timeout(SERVER_PROBE_MS);
  const answer: unknown = await fetch(url, { signal })
    .then((response) => response.json())
    .catch(() => null);
  const running = z.object({ dataDir: z.string() }).safeParse(answer);
  if (running.success && running.data.dataDir === config.dataDir) {
    const stop = "Stop it, run the import, then start it again.";
    throw new Error(`A bb server is running on ${config.dataDir}. ${stop}`);
  }
}

function tableWriter(db: Db, counts: Record<string, Numbers>): Add {
  const inserts = new Map<string, string>();
  return (table, row) => {
    let sql = inserts.get(table);
    if (sql === undefined) {
      const names = db
        .all<{ name: string }>("SELECT name FROM pragma_table_info(?)", table)
        .flatMap(({ name }) => (name in row ? [name] : []));
      const values = names.map((name) => `@${name}`).join(", ");
      sql = `INSERT OR IGNORE INTO ${table} (${names.join(", ")})
        VALUES (${values})`;
      inserts.set(table, sql);
    }
    const tally = (counts[table] ??= { imported: 0, skipped: 0 });
    const outcome = db.run(sql, row).changes === 1 ? "imported" : "skipped";
    tally[outcome] = (tally[outcome] ?? 0) + 1;
  };
}

function importCatalog(
  legacy: Legacy,
  db: Db,
  add: Add,
  chosen: string,
  hostId: (id?: SqlValue) => SqlValue,
): void {
  const onHost = (row: Row): Row => ({ ...row, host_id: hostId(row.host_id) });
  const copy = (table: string, sql = `SELECT * FROM ${table}`, edit = onHost) =>
    rows(legacy, sql).forEach((row) => add(table, edit(row)));
  db.run("PRAGMA defer_foreign_keys = ON");
  copy("threads", THREADS + chosen);
  copy("environments", `${ENVIRONMENTS}${chosen})`);
  copy("thread_sections");
  copy("project_sources");
  copy("projects", PROJECTS);
  copy("hosts", HOSTS, (host) => ({ ...host, id: hostId(host.id) }));
  for (const [column, table] of Object.entries(THREAD_LINKS)) {
    db.run(`UPDATE threads SET ${column} = NULL
      WHERE ${column} NOT IN (SELECT id FROM ${table})`);
  }
  copy("settings", SETTINGS);
  copy("ui_preferences");
  copy("plugin_kv", SIDEBAR_PREFERENCES);
}

function importThread(legacy: Legacy, db: Db, add: Add, id: SqlValue): number {
  const settled = `SELECT item_id FROM events
    WHERE thread_id = ? AND type = 'item/completed'`;
  const completed = new Set(rows(legacy, settled, id).map((e) => e.item_id));
  const kept = new Set<string>();
  const repeats = (key: string): boolean => kept.size === kept.add(key).size;
  const stored = legacy
    .prepare("SELECT * FROM events WHERE thread_id = ? ORDER BY sequence")
    .iterate(id) as IterableIterator<Row>;
  let pruned = 0;
  for (const event of stored) {
    const type = String(event.type);
    const settledDelta = DELTA_TYPE.test(type) && completed.has(event.item_id);
    if (settledDelta && repeats(`${event.item_id}|${type}`)) pruned += 1;
    else add("events", event);
  }
  db.run(RESTORE_SESSION, { id });
  for (const [table, changed] of Object.entries(THREAD_CONTENT)) {
    const sql = `SELECT *${changed} FROM ${table} WHERE thread_id = ?`;
    for (const row of rows(legacy, sql, id)) add(table, row);
  }
  return pruned;
}

export async function importLegacy(options: ImportLegacyOptions) {
  const startedAt = Date.now();
  const { from, dryRun, threads } = options;
  const choices: Record<string, Numbers> = {};
  const counts: Record<string, Numbers> = {};
  const fixed = { dryRun, from, threads, choices, counts };
  const summary = (dataDir: string | null) => {
    const elapsedMs = Date.now() - startedAt;
    return { ...fixed, dataDir, notImported: NOT_IMPORTED, elapsedMs };
  };
  const readOnly = { readonly: true, fileMustExist: true };
  const legacy = new Database(join(from, "bb.db"), readOnly);
  try {
    legacy.pragma("query_only = ON");
    const select = (among: string): Row[] =>
      rows(legacy, `SELECT id FROM threads WHERE ${among}`);
    for (const [choice, among] of dryRun ? Object.entries(CHOSEN) : []) {
      const found = select(among);
      const events = eventCount(legacy, found);
      choices[choice] = { threads: found.length, events };
    }
    if (dryRun) return summary(null);
    const config = loadConfig(options.env);
    await refuseRunningServer(config);
    const paths = dataPaths(config.dataDir);
    const hostFile = join(from, "host-id");
    const hosts = rows(legacy, HOSTS);
    const local = existsSync(hostFile)
      ? readFileSync(hostFile, "utf8").trim()
      : hosts[0]?.id;
    const hostId = (id: SqlValue = null): SqlValue =>
      id === local ? config.hostId : id;
    const db = openDatabase({ path: paths.database });
    try {
      const add = tableWriter(db, counts);
      const chosen = CHOSEN[threads];
      db.transaction(() => importCatalog(legacy, db, add, chosen, hostId));
      const events = (counts.events = { imported: 0, skipped: 0, pruned: 0 });
      for (const thread of select(chosen)) {
        const id = thread.id ?? null;
        const work = (): number => importThread(legacy, db, add, id);
        if (db.get(EMPTY_THREAD, id) === undefined) {
          events.skipped += eventCount(legacy, [thread]);
        } else events.pruned += db.transaction(work);
      }
    } finally {
      db.close();
    }
    return summary(config.dataDir);
  } finally {
    legacy.close();
  }
}

export function importSummaryLines(summary: ImportLegacySummary): string[] {
  const { choices, counts, dataDir, from } = summary;
  const seconds = (summary.elapsedMs / 1_000).toFixed(1);
  const line = ([kind, numbers]: [string, Numbers]): string => {
    const parts = Object.entries(numbers).map(([unit, n]) => `${n} ${unit}`);
    return `  ${kind}: ${parts.join(", ")}`;
  };
  return [
    summary.dryRun
      ? `Dry run of ${from}: nothing written. By --threads choice:`
      : `Imported ${from} into ${dataDir} in ${seconds}s (skipped = present):`,
    ...Object.entries({ ...choices, ...counts }).map(line),
    `Not imported: ${summary.notImported}.`,
  ];
}
