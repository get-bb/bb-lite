import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, onTestFinished, test } from "vitest";
import { loadConfig } from "../src/config.js";
import type { Db, SqlParams } from "../src/db/index.js";
import { importLegacy, type ThreadChoice } from "../src/import-legacy.js";
import { createTestServer } from "./helpers.js";
import * as seed from "./thread-seed.js";

const REQUEST = "creq_aaaaaaaaa2";
const ORIGINAL_SQL = `
CREATE TABLE hosts (id text PRIMARY KEY, name text, type text, destroyed_at
  integer, max_permission_mode text DEFAULT 'full', created_at integer,
  updated_at integer);
CREATE TABLE projects (id text PRIMARY KEY, name text, created_at integer,
  updated_at integer);
CREATE TABLE project_execution_defaults (project_id text, provider_id text,
  model text, service_tier text, reasoning_level text, permission_mode text);
CREATE TABLE project_sources (id text PRIMARY KEY, project_id text,
  host_id text, path text, created_at integer, updated_at integer);
CREATE TABLE environments (id text PRIMARY KEY, project_id text, host_id text,
  path text, status text DEFAULT 'provisioning', provider_owns_path integer,
  created_at integer, updated_at integer);
CREATE TABLE thread_sections (id text PRIMARY KEY, name text,
  created_at integer, updated_at integer);
CREATE TABLE threads (id text PRIMARY KEY, project_id text, environment_id text,
  provider_id text, title text, status text, parent_thread_id text,
  source_thread_id text, lifecycle_owner_thread_id text, origin_kind text,
  section_id text, archived_at integer, deleted_at integer, last_read_at
  integer, latest_attention_at integer, created_at integer, updated_at integer);
CREATE TABLE events (id text PRIMARY KEY, thread_id text, environment_id text,
  scope_kind text, turn_id text, provider_thread_id text, sequence integer,
  type text, item_id text, item_kind text, data text, created_at integer,
  parent_tool_call_id text);
CREATE TABLE pending_interactions (id text PRIMARY KEY, thread_id text,
  status text, payload text, status_reason text, created_at integer,
  resolved_at integer, updated_at integer);
CREATE TABLE prompt_history_entries (id text PRIMARY KEY, thread_id text);
CREATE TABLE thread_search_segments (id text PRIMARY KEY, thread_id text);
CREATE TABLE app_settings_values (key text, value text, updated_at integer);
CREATE TABLE app_theme (id text PRIMARY KEY, theme_id text, updated_at integer,
  favicon_color text);
CREATE TABLE ui_preferences (key text PRIMARY KEY, value_json text);
CREATE TABLE plugin_kv (plugin_id text, key text, value text);
INSERT INTO hosts (id, name, type, created_at, updated_at)
  VALUES ('host_old', 'bee', 'persistent', 1, 1);
INSERT INTO projects VALUES ('proj_demo', 'demo', 1, 1);
INSERT INTO thread_sections VALUES ('sec_later', 'Later', 1, 1);
INSERT INTO environments (id, project_id, host_id, created_at, updated_at)
  VALUES ('env_demo', 'proj_demo', 'host_old', 1, 1);
INSERT INTO pending_interactions (id, thread_id, status, payload, created_at,
  updated_at) VALUES ('pint_1', 'thr_busy', 'pending', '{}', 1, 1);`;

function seedOriginal(file: string): void {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(ORIGINAL_SQL);
  const call = (method: "get" | "all" | "run") => {
    return (sql: string, ...params: SqlParams): unknown =>
      sqlite.prepare(sql)[method](...params);
  };
  const db = { get: call("get"), all: call("all"), run: call("run") } as Db;
  seed.seedThread(db, "thr_parent", { section_id: "sec_later" });
  seed.seedThread(db, "thr_child", { parent_thread_id: "thr_parent" });
  seed.seedThread(db, "thr_busy", { status: "active" });
  seed.seedThread(db, "thr_archived", { archived_at: 2_000 });
  const turn = seed.agentTurn("t1", REQUEST, "answer 1");
  seed.appendEvents(db, "thr_parent", [
    seed.userRequest(REQUEST, "question 1"),
    { type: "thread/identity", data: { providerThreadId: "session-1" } },
    ...turn.slice(0, 6).concat(turn.slice(5)),
  ]);
  seed.appendEvents(db, "thr_archived", [seed.userRequest(REQUEST, "old")]);
  sqlite.close();
}

test("moves an original install into a fresh data directory", async () => {
  const from = mkdtempSync(join(tmpdir(), "bb-original-"));
  const dataDir = join(from, "imported");
  onTestFinished(() => rmSync(from, { recursive: true, force: true }));
  const file = join(from, "bb.db");
  seedOriginal(file);
  const untouched = [readFileSync(file), statSync(file).mtimeMs];
  const env = { BB_DATA_DIR: dataDir, BB_SERVER_PORT: "0" };
  const run = (threads: ThreadChoice, dryRun = false) =>
    importLegacy({ from, threads, dryRun, env });
  const { choices } = await run("active", true);
  expect([choices.all?.threads, choices.active?.threads]).toEqual([4, 3]);
  const { counts } = await run("active");
  expect(counts.events).toEqual({ imported: 10, skipped: 0, pruned: 1 });
  const rerun = Object.values((await run("active")).counts);
  expect(rerun.filter((tally) => tally.imported !== 0)).toEqual([]);
  expect([readFileSync(file), statSync(file).mtimeMs]).toEqual(untouched);
  const { hostId } = loadConfig(env);
  const databasePath = join(dataDir, "bb.db");
  const server = await createTestServer(
    { dataDir, hostId },
    "fake",
    databasePath,
  );
  const get = async (path: string): Promise<Record<string, unknown>[]> => {
    const body = await fetch(`${server.url}/api/v1${path}`);
    return [(await body.json()) as Record<string, unknown>[]].flat();
  };
  const names = { sections: [{ name: "Later" }], projects: [{ name: "demo" }] };
  expect((await get("/sidebar-bootstrap"))[0]).toMatchObject(names);
  const threads = await get("/threads");
  const listed = (id: string) => threads.find((thread) => thread.id === id);
  expect(threads).toHaveLength(3);
  expect(listed("thr_busy")).toMatchObject({ status: "idle" });
  expect(listed("thr_child")).toMatchObject({ parentThreadId: "thr_parent" });
  expect(listed("thr_parent")).toMatchObject({ sectionId: "sec_later" });
  expect(await get("/threads?archived=true")).toEqual([]);
  const said = [{ text: "question 1" }, { kind: "turn" }, { text: "answer 1" }];
  const [timeline] = await get("/threads/thr_parent/timeline");
  expect(timeline?.rows).toMatchObject(said);
  const moved = `SELECT t.provider_thread_id, model, p.status, host_id
    FROM threads t, pending_interactions p, environments WHERE model NOT NULL`;
  const kept = ["session-1", "gpt-test", "interrupted", hostId];
  expect(Object.values(server.ctx.db.get<object>(moved) ?? {})).toEqual(kept);
});
