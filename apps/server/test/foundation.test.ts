import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultAppSettings,
  getUiPreferenceDefault,
  type RealtimeSubscriptionTarget,
  type ThreadEventType,
} from "@bb/domain";
import Database from "better-sqlite3";
import { expect, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config.js";
import * as database from "../src/db/index.js";
import { authorize } from "../src/http/trust.js";
import { Hub } from "../src/ws/hub.js";
import { createTestServer } from "./helpers.js";

type Headers = Record<string, string>;
type Sent = { metadata?: { eventTypes?: string[] } };
const scratch = (): string => mkdtempSync(join(tmpdir(), "bb-test-"));

it("applies the schema once, maps columns and keeps search in step", () => {
  const path = join(scratch(), "bb.db");
  const first = database.openDatabase({ path, now: () => 42 });
  const id = database.newId("thr");
  expect(`${first.now()} ${id}`).toMatch(/^42 thr_[2-9a-km-np-z]{10}$/u);
  first.run(
    "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P', 1, 1)",
  );
  first.run(
    `INSERT INTO threads
       (id, project_id, provider_id, latest_attention_at, created_at, updated_at)
     VALUES (?, 'p1', 'echo', 1, 1, 1)`,
    id,
  );
  first.run(
    `INSERT INTO thread_search_segments
     VALUES ('seg', ?, 'title', 'title', NULL, 'refactor the scheduler', 1, 1)`,
    id,
  );
  first.close();

  const db = database.openDatabase({ path });
  const hits = (term: string): number =>
    db.all("SELECT rowid FROM thread_search_segments_fts(?)", term).length;
  expect(db.get("PRAGMA user_version")).toEqual({ userVersion: 1 });
  const thread = { projectId: "p1", status: "starting" };
  expect(db.get("SELECT project_id, status FROM threads")).toEqual(thread);
  expect(hits("sched*")).toBe(1);
  db.run("UPDATE thread_search_segments SET text = 'ship the importer'");
  expect(hits("sched*") + hits("importer")).toBe(1);
  db.run("DELETE FROM threads");
  expect(hits("importer")).toBe(0);
  expect(() => db.transaction(async () => {})).toThrow("synchronous");
});

it("refuses a data directory of the original bb without touching it", () => {
  const dataDir = scratch();
  const legacy = new Database(join(dataDir, "bb.db"));
  legacy.exec("CREATE TABLE __drizzle_migrations (id INTEGER)");
  const refusal = database.LegacyDataDirectoryError;
  expect(() => loadConfig({ BB_DATA_DIR: dataDir })).toThrow(refusal);
  expect(readdirSync(dataDir)).toEqual(["bb.db"]);
});

function hubClient(hub: Hub, ...targets: RealtimeSubscriptionTarget[]) {
  const sent: Sent[] = [];
  const send = (data: string): void => void sent.push(JSON.parse(data) as Sent);
  const socket = { sent, send, close: vi.fn() };
  hub.connect(socket);
  for (const target of targets) {
    hub.receive(socket, JSON.stringify({ type: "subscribe", target }));
  }
  return socket;
}

it("routes changes to list and detail subscribers and tracks them", () => {
  const hub = new Hub();
  const edges: string[] = [];
  hub.onSubscriptionChange((target, on) => edges.push(`${target.kind} ${on}`));
  const projectOne = { kind: "project-detail", projectId: "p1" } as const;
  const list = hubClient(hub, { kind: "project-list" });
  const detail = hubClient(hub, projectOne);
  const other = hubClient(hub, { kind: "project-detail", projectId: "p2" });
  hub.project("p1", ["project-updated"]);
  const change = { type: "changed", entity: "project", id: "p1" };
  expect(list.sent).toEqual([{ ...change, changes: ["project-updated"] }]);
  expect([detail.sent, other.sent]).toEqual([list.sent, []]);
  expect(hub.pluginSignal("tasks", "board", { n: 1 })).toBe(3);
  hub.receive(other, "not json");
  expect(other.close).toHaveBeenCalledWith(1008, "invalid-message");
  hub.disconnect(detail);
  const detailEdges = edges.slice(1).join().replaceAll("project-detail ", "");
  expect(detailEdges).toBe("true,true,false");
});

it("coalesces events-appended for list-only subscribers", () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const hub = new Hub();
  const threadOne = { kind: "thread-detail", threadId: "thr_1" } as const;
  const listOnly = hubClient(hub, { kind: "thread-list" });
  const viewer = hubClient(hub, { kind: "thread-list" }, threadOne);
  const append = (type: ThreadEventType): void =>
    hub.thread("thr_1", ["events-appended"], { eventTypes: [type] });
  const eventTypes = (): unknown[] =>
    listOnly.sent.map((message) => message.metadata?.eventTypes?.join());
  append("item/started");
  append("item/agentMessage/delta");
  append("item/completed");
  expect([viewer.sent.length, eventTypes()]).toEqual([3, ["item/started"]]);
  vi.advanceTimersByTime(1_000);
  expect(eventTypes()[1]).toBe("item/agentMessage/delta,item/completed");
  append("turn/completed");
  hub.thread("thr_1", ["status-changed"], { projectId: "p1" });
  vi.advanceTimersByTime(5_000);
  expect([listOnly.sent.length, viewer.sent.length]).toEqual([4, 5]);
});

const loopback = { host: "127.0.0.1:48886" };
const tunnel = { ...loopback, "x-bb-via-tunnel": "1" };
const session = { ...tunnel, "x-bb-gate-auth": "session" };
const machine = { ...tunnel, "x-bb-gate-auth": "machine" };
const evil = { origin: "https://evil.example" };
const remote = "100.64.0.7";
const enrolled = { authorization: "Bearer bbr_enrolled" };
const revoked = { authorization: "Bearer bbr_revoked" };
const lookups = {
  publicUrl: () => "https://bee.example.test",
  runnerMachine: (token: string) =>
    token === "bbr_enrolled" ? { connectMachineId: null } : undefined,
};

it.each<[string | number, Headers, string?, string?]>([
  ["owner", loopback],
  ["owner", { ...loopback, origin: "http://127.0.0.1:48886" }],
  ["owner", { ...loopback, origin: "https://bee.example.test" }],
  [403, { ...loopback, ...evil }],
  [403, { ...loopback, origin: "http://127.0.0.1:3000" }],
  [403, { host: "evil.example:48886" }],
  ["owner", session],
  [403, { ...session, ...evil }],
  [404, tunnel],
  [404, session, "GET /api/v1/threads", remote],
  ["runner", machine, "POST /api/v1/threads/thr_1/send"],
  [403, machine, "POST /api/v1/hosts"],
  [403, machine, "PUT /api/v1/settings/general"],
  ["anonymous", {}, "POST /internal/runner/join", remote],
  ["runner", enrolled, "POST /api/v1/threads/thr_1/send", remote],
  [403, enrolled, "DELETE /api/v1/hosts/host_1"],
  [404, revoked, "GET /api/v1/threads"],
  ["anonymous", revoked, "GET /internal/runner/ws"],
  ["runner", { ...machine, ...revoked }, "GET /api/v1/threads"],
])("trust guard answers %s for %j %s %s", (expected, headers, route, peer) => {
  const [method = "GET", path = "/api/v1/threads"] = route?.split(" ") ?? [];
  const socket = { remoteAddress: peer ?? "127.0.0.1" };
  const request = { method, path, headers, socket };
  const verdict = (): string => authorize(request, lookups).kind;
  if (typeof expected === "string") expect(verdict()).toBe(expected);
  else expect(verdict).toThrow(expect.objectContaining({ status: expected }));
});

it("answers errors in the API envelope", async () => {
  const { url, ctx } = await createTestServer();
  const outcome = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${url}${path}`, init);
    return [response.status, ...Object.values(await response.json())].join();
  };
  expect(await outcome("/api/v1/nope")).toBe("404,not_found,Not found");
  const config = "/api/v1/system/config";
  expect(await outcome(config, { headers: evil })).toContain("403,forbidden_o");
  const empty = { method: "PUT", body: "{}" };
  const appearance = await outcome("/api/v1/settings/appearance", empty);
  expect(appearance).toContain("400,invalid_request");
  ctx.db.close();
  const internal = "500,internal_error,Internal server error";
  expect(await outcome("/api/v1/preferences/ui")).toBe(internal);
});

it("guards ui preferences with per-key revisions", async () => {
  const { api } = await createTestServer();
  const key = "sidebar.organizationMode";
  const value = getUiPreferenceDefault(key);
  const { preferences } = await (await api.preferences.ui.$get()).json();
  expect(preferences[key]).toEqual({ revision: 0, value });
  const write = async (expectedRevision: number, next: unknown) => {
    const json = { expectedRevision, value: next };
    const path = api.preferences.ui[":key"];
    const response = await path.$put({ param: { key }, json });
    return { status: response.status, ...(await response.json()) };
  };
  const saved = { status: 200, key, revision: 1, value: "machine" };
  expect(await write(0, "machine")).toEqual(saved);
  const conflict = { status: 409, code: "ui_preference_conflict" };
  const details = { currentRevision: 1 };
  expect(await write(0, "project")).toMatchObject({ ...conflict, details });
  const reset = await api.preferences.ui[":key"].$delete({ param: { key } });
  expect(await reset.json()).toEqual({ key, revision: 2, value });
});

it("announces settings writes to system subscribers", async () => {
  const { api, socket, url } = await createTestServer();
  const client = await socket();
  await client.subscribe({ kind: "system" });
  const json = { ...defaultAppSettings, steerActiveThreadOnEnter: false };
  expect((await api.settings.general.$put({ json })).status).toBe(200);
  const changes = ["config-changed"];
  expect(await client.next()).toMatchObject({ entity: "system", changes });
  const config = await (await api.system.config.$get()).json();
  expect(config.generalSettings.steerActiveThreadOnEnter).toBe(false);
  expect(config.keybindings.length).toBeGreaterThan(40);
  const refused = new WebSocket(`${url.replace("http", "ws")}/ws`, evil);
  refused.on("error", () => {});
  const status = await new Promise((resolve) =>
    refused.on("unexpected-response", (_request, { statusCode }) =>
      resolve(statusCode),
    ),
  );
  expect(status).toBe(403);
});

it("serves the app with an SPA fallback that spares /assets", async () => {
  const outside = scratch();
  const appDir = join(outside, "app");
  mkdirSync(join(appDir, "assets"), { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "secret");
  writeFileSync(join(appDir, "index.html"), "<html>bb</html>");
  writeFileSync(join(appDir, "assets", "app-abc.js"), "export {};");
  const { url } = await createTestServer({ appDir });
  const get = (path: string, headers: Headers = {}) =>
    fetch(`${url}${path}`, { headers });
  const route = await get("/threads/thr_1");
  expect(await route.text()).toBe("<html>bb</html>");
  expect((await get("/assets/app-abc.js")).status).toBe(200);
  expect((await get("/assets/app-old.js")).status).toBe(404);
  expect((await get("/assets/..%2F..%2Fsecret.txt")).status).toBe(404);
  const etag = String(route.headers.get("etag")).replace("W/", "");
  const cached = await get("/", { "if-none-match": `"other", ${etag}` });
  expect(cached.status).toBe(304);
});

it("fans runner events out by kind and acknowledges reliable ones", async () => {
  const { ctx, runner } = await createTestServer();
  const seen: string[] = [];
  ctx.runners.onEvent("script.output", async (event, hostId) => {
    seen.push(`${hostId === ctx.config.hostId} ${event.text}`);
  });
  const kind = "script.output";
  const output = { kind, operationId: "op", text: "hi" } as const;
  runner.emit({ lane: "reliable", seq: 7, ...output });
  const acknowledged = [{ method: "ackEvents", args: [{ seq: 7 }] }];
  await vi.waitFor(() => expect(runner.calls).toEqual(acknowledged));
  expect(seen).toEqual(["true hi"]);
  const offline = expect.objectContaining({ status: 502 });
  expect(() => ctx.runners.get("host_other")).toThrow(offline);
});
