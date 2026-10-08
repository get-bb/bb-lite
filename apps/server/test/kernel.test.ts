import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  contract,
  deny,
  live,
  op,
  sessions,
  table,
  threads as threadOps,
  type PluginServerApi,
  plugins as hostOps,
} from "@bb/plugin";
import { createThreadRequestSchema } from "@bb/server-contract";
import { expect, it } from "vitest";
import { z } from "zod";
import { runAs } from "@bb/server-kit/auth/actor";
import { insertRow } from "@bb/server-kit/db/index";
import { PluginHost } from "../src/plugins/host.js";
import { scratch } from "./helpers.js";
import { createThreadServer, text } from "./thread-harness.js";

interface Entry {
  op: string;
  userId: string | null;
  door: string;
  threadId: string | null;
  via: string[];
  hooks: { plugin: string; action: string }[];
  outcome: string;
  detail: string | null;
  input: string | null;
}

const APP = { "x-bb-door": "app" };

async function auditOf(
  server: Awaited<ReturnType<typeof createThreadServer>>,
  query: Record<string, string> = {},
  extra: Record<string, string> = {},
) {
  const headers = { "content-type": "application/json", ...extra };
  const body = JSON.stringify(query);
  const posted = { method: "POST", headers, body };
  const response = await server.request("/ops/audit.list", posted);
  const { result } = (await response.json()) as { result: Entry[] };
  return result.reverse();
}

it("records who changed a thread, through which door and which plugin", async () => {
  const server = await createThreadServer();
  const { ctx } = server;
  const threadId = await server.spawn();
  const message = { input: text("Run the tests again"), mode: "auto" };
  const headers = { "content-type": "application/json", ...APP };
  const body = JSON.stringify(message);
  const posted = { method: "POST", headers, body };
  const sent = await server.request(`/threads/${threadId}/send`, posted);
  expect(sent.status).toBe(200);
  await server.settle();
  const agent = { userId: "usr_owner", role: "owner", agentThreadId: threadId };
  const request = createThreadRequestSchema.parse({
    projectId: "proj_1",
    input: text("Investigate the flaky scheduler test"),
    model: "gpt-test",
    environment: { type: "project-default" },
    startedOnBehalfOf: null,
    origin: "plugin",
    originPluginId: "tasks",
  });
  const tasks = ctx.kernel.scope("tasks", "product");
  const spawned = await runAs({ ...agent, role: "owner" }, () =>
    tasks.call(threadOps.create, request),
  );
  await server.settle();
  const trail = (await auditOf(server)).map((entry) => [
    entry.op,
    entry.userId,
    entry.door,
    entry.threadId,
    entry.via.join(">"),
    entry.outcome,
  ]);
  const ensured = "tasks>threads";
  expect(trail).toEqual([
    ["threads.create", "usr_owner", "http", null, "", "ok"],
    ["environments.ensure", "usr_owner", "http", null, "threads", "ok"],
    ["threads.send", "usr_owner", "app", null, "", "ok"],
    ["threads.create", "usr_owner", "agent", threadId, "tasks", "ok"],
    ["environments.ensure", "usr_owner", "agent", threadId, ensured, "ok"],
  ]);
  const [, , send] = await auditOf(server);
  expect(send.input).toContain(threadId);
  const byPlugin = await auditOf(server, { plugin: "tasks" });
  const viaTasks = ["threads.create", "environments.ensure"];
  expect(byPlugin.map(({ op }) => op)).toEqual(viaTasks);
  expect(spawned.originPluginId).toBe("tasks");
  const cli = { argv: ["list", "--op", "threads.send"], cwd: "/" };
  const listed = await server.http("POST", "/plugins/audit/cli", cli);
  const line = "threads.send  usr_owner  app > audit  ok";
  expect(listed.body).toMatchObject({ exitCode: 0 });
  expect(String(listed.body.stdout)).not.toContain(line);
  expect(String(listed.body.stdout)).toMatch(
    /threads\.send {2}usr_owner {2}app {2}ok$/u,
  );
});

it("lets a plugin refuse a write and names it in the answer and the record", async () => {
  const server = await createThreadServer();
  const { ctx } = server;
  const threadId = await server.spawn();
  const guard = ctx.kernel.scope("quiet-hours", "installed");
  guard
    .on(threadOps.send, { threadId }, () => deny("Held until morning"))
    .failClosed();
  const message = { input: text("Push it"), mode: "auto" };
  const refused = await server.http(
    "POST",
    `/threads/${threadId}/send`,
    message,
  );
  expect(refused).toEqual({
    status: 403,
    body: {
      code: "denied_by_plugin",
      message: "Held until morning",
      details: { plugin: "quiet-hours" },
    },
  });
  const [last] = (await auditOf(server)).slice(-1);
  expect(last).toMatchObject({
    op: "threads.send",
    outcome: "denied",
    detail: "Held until morning",
    hooks: [{ plugin: "quiet-hours", action: "denied" }],
  });
  guard.dispose();
  const allowed = await server.http(
    "POST",
    `/threads/${threadId}/send`,
    message,
  );
  expect(allowed.status).toBe(200);
});

it("shows a member only their own records", async () => {
  const server = await createThreadServer();
  const { ctx } = server;
  const at = { createdAt: 1, updatedAt: 1 };
  const bo = { id: "usr_bo", name: "Bo", role: "member", externalId: "ext_bo" };
  insertRow(ctx.db, "users", { ...bo, ...at });
  const ownerThread = await server.spawn();
  const member = { userId: "usr_bo", role: "member", agentThreadId: null };
  const stopping = runAs({ ...member, role: "member" }, () =>
    ctx.threads.stop(ownerThread),
  );
  await expect(stopping).rejects.toMatchObject({
    body: { code: "machine_not_shared" },
  });
  const gate = {
    "x-bb-via-tunnel": "1",
    "x-bb-gate-auth": "session",
    "x-bb-gate-user-id": "ext_bo",
  };
  const mine = await auditOf(server, { user: "usr_owner" }, gate);
  expect(mine.map(({ op, userId, outcome }) => [op, userId, outcome])).toEqual([
    ["threads.stop", "usr_bo", "error"],
  ]);
  const everything = await auditOf(server);
  expect(everything.map(({ op }) => op)).toEqual([
    "threads.create",
    "environments.ensure",
    "threads.stop",
  ]);
});

it("serves operations and the live chain over HTTP", async () => {
  const server = await createThreadServer();
  const set = ["set", "Always", "use", "pnpm"];
  const cli = { argv: set, cwd: "/" };
  await server.http("POST", "/plugins/custom-instructions/cli", cli);
  const context = {
    threadId: "thr_1",
    projectId: "proj_1",
    hostId: null,
    providerId: "codex",
  };
  const called = await server.http(
    "POST",
    `/ops/${sessions.instructions.name}`,
    context,
  );
  expect(called).toEqual({
    status: 200,
    body: {
      ok: true,
      result: [{ source: "custom-instructions", text: "Always use pnpm" }],
    },
  });
  const unknown = await server.http("POST", "/ops/nope.nothing", {});
  expect(unknown.status).toBe(404);
  for (const name of ["threads.create", "threads.send", "files.write"]) {
    const closed = await server.http("POST", `/ops/${name}`, {});
    expect([name, closed.status]).toEqual([name, 403]);
  }
  const machine = { "x-bb-via-tunnel": "1", "x-bb-gate-auth": "machine" };
  const json = { "content-type": "application/json" };
  const reload = (headers: Record<string, string>) =>
    server.request("/ops/plugins.reload", {
      method: "POST",
      headers: { ...json, ...headers },
      body: "{}",
    });
  expect((await reload(machine)).status).toBe(403);
  expect((await reload({})).status).toBe(200);
  const invalid = await server.http("POST", "/ops/threads.stop", {});
  expect(invalid).toMatchObject({
    status: 400,
    body: { code: "invalid_request" },
  });
  const { body } = await server.http<{
    ops: { name: string; owner: string; chain: { plugin: string }[] }[];
  }>("GET", "/kernel");
  const instructions = body.ops.find(
    ({ name }) => name === "sessions.instructions",
  );
  expect(instructions?.owner).toBe("sessions");
  expect(instructions?.chain).toContainEqual({
    plugin: "custom-instructions",
    tier: "product",
    failClosed: false,
  });
  const send = body.ops.find(({ name }) => name === "threads.send");
  expect(send).toMatchObject({ owner: "threads", kind: "write", doors: [] });
});

it("offers one operation to agents and the CLI, and pushes changes", async () => {
  const server = await createThreadServer();
  const { ctx } = server;
  const notes = contract("notes", {
    add: op({
      input: z.object({
        text: z.string().describe("What to remember"),
        pinned: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
      }),
      output: z.object({ id: z.number(), text: z.string() }),
      kind: "write",
      doors: {
        agent: {
          name: "AddNote",
          description: "Remember a note",
          instructions: "Use AddNote for things worth keeping.",
          enabledFor: ({ providerId }) => providerId === "codex",
        },
        cli: {
          path: "notes add",
          summary: "Remember a note",
          positionals: ["text"],
          print: ({ id, text }) => `Note ${id}: ${text}`,
        },
      },
    }),
    count: live(z.number()),
  });
  const configFile = join(ctx.config.dataDir, "config.json");
  const directory = scratch();
  const manifest = { name: "bb-plugin-notes", bb: { name: "Notes" } };
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  const kept: { text: string; who: string; tags: string[] }[] = [];
  const plugin = (bb: PluginServerApi) => {
    const count = bb.provide(notes.count, 0);
    bb.implement(notes.add, ({ text, tags = [] }, { caller }) => {
      const who = `${caller.user}/${caller.door}/${caller.thread}`;
      kept.push({ text, who, tags });
      count.set(kept.length);
      return { id: kept.length, text };
    });
  };
  const host = new PluginHost({
    ...ctx.plugins.options,
    builtins: [{ directory, server: plugin }],
  });
  writeFileSync(configFile, "{}");
  await host.reload();
  const client = await server.socket();
  const threadId = await server.spawn();
  const scope = { threadId, projectId: "proj_1", hostId: null };
  const codex = { ...scope, providerId: "codex" };
  const { kernel } = ctx;
  const offered = await kernel.call(sessions.tools, codex);
  expect(offered.map(({ name }) => name)).toContain("AddNote");
  const claude = { ...scope, providerId: "claude-code" };
  const elsewhere = await kernel.call(sessions.tools, claude);
  expect(elsewhere.map(({ name }) => name)).not.toContain("AddNote");
  const guidance = await kernel.call(sessions.instructions, codex);
  expect(guidance.map(({ text }) => text).join("\n")).toContain("Use AddNote");
  const agent = { userId: "usr_owner", role: "owner", agentThreadId: threadId };
  const addNote = (input: unknown) =>
    kernel.call(hostOps.callAgentTool, {
      name: "AddNote",
      input,
      context: codex,
    });
  const called = await runAs({ ...agent, role: "owner" }, () =>
    addNote({ text: "ship on friday" }),
  );
  const done = '{"id":1,"text":"ship on friday"}';
  expect(called).toEqual({
    success: true,
    contentItems: [{ type: "inputText", text: done }],
  });
  expect((await addNote({})).success).toBe(false);
  const cli = host.cliOf("notes");
  expect(host.contributions().cliCommands).toContainEqual({
    pluginId: "notes",
    name: "notes",
    summary: "",
    commands: [{ name: "add", summary: "Remember a note" }],
  });
  const context = { signal: new AbortController().signal };
  const argv = ["add", "buy", "--tags", "a", "--tags", "b", "--pinned"];
  expect(await cli?.run(argv, context)).toEqual({
    exitCode: 0,
    stdout: "Note 2: buy",
  });
  const asJson = await cli?.run(["add", "third", "--json"], context);
  expect(JSON.parse(asJson?.stdout ?? "")).toEqual({ id: 3, text: "third" });
  const usage = await cli?.run(["add"], context);
  expect(usage).toMatchObject({ exitCode: 1 });
  expect(usage?.stderr).toContain("missing <text>");
  expect(kept).toEqual([
    { text: "ship on friday", who: `usr_owner/agent/${threadId}`, tags: [] },
    { text: "buy", who: "null/system/null", tags: ["a", "b"] },
    { text: "third", who: "null/system/null", tags: [] },
  ]);
  const value = await server.http("POST", "/ops/notes.count");
  expect(value.body).toEqual({ ok: true, result: 3 });
  const pushed = await client.next(
    ({ type, channel }) => type === "plugin-signal" && channel === "changed",
  );
  expect(pushed).toMatchObject({
    pluginId: "kernel",
    payload: { name: "notes.count" },
  });
  await host.stop();
});

it("keeps a per-user plugin setting apart for each person", async () => {
  const server = await createThreadServer();
  const { ctx } = server;
  const directory = scratch();
  const manifest = {
    name: "bb-plugin-layouts",
    bb: { name: "Layouts", server: "./server.ts" },
  };
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  writeFileSync(
    join(directory, "server.ts"),
    `export default function plugin(bb) {
      const text = { type: "string", label: "Value" };
      bb.settings.define({ banner: { ...text, default: "none" } });
      const mine = bb.settings.define(
        { layout: { ...text, default: "list" } },
        { scope: "user" },
      );
      bb.http.route("GET", "/layout", async () =>
        Response.json(await mine.get()), { auth: "none" });
    }`,
  );
  const configFile = join(ctx.config.dataDir, "config.json");
  const plugins = [{ path: directory }];
  writeFileSync(configFile, JSON.stringify({ plugins }));
  await ctx.plugins.reload();
  const at = { createdAt: 1, updatedAt: 1 };
  const bo = { id: "usr_bo", name: "Bo", role: "member", externalId: "ext_bo" };
  insertRow(ctx.db, "users", { ...bo, ...at });
  const gate = {
    "x-bb-via-tunnel": "1",
    "x-bb-gate-auth": "session",
    "x-bb-gate-user-id": "ext_bo",
  };
  const call = async (method: string, values?: object, headers = {}) => {
    const json = { "content-type": "application/json", ...headers };
    const body = values === undefined ? undefined : JSON.stringify({ values });
    const init = { method, headers: json, body };
    const response = await server.request("/plugins/layouts/settings", init);
    const reply = (await response.json()) as { values?: object };
    return [response.status, reply.values];
  };
  expect(await call("PUT", { layout: "grid", banner: "hi" })).toEqual([
    200,
    { layout: "grid", banner: "hi" },
  ]);
  expect(await call("GET", undefined, gate)).toEqual([
    200,
    { layout: "list", banner: "hi" },
  ]);
  expect(await call("PUT", { layout: "board" }, gate)).toEqual([
    200,
    { layout: "board", banner: "hi" },
  ]);
  expect((await call("PUT", { banner: "mine" }, gate))[0]).toBe(403);
  expect(await call("GET")).toEqual([200, { layout: "grid", banner: "hi" }]);
  const own = await server.request("/plugins/layouts/http/layout", {
    headers: gate,
  });
  expect(await own.json()).toMatchObject({ layout: "board" });
});

it("lets a plugin add a timeline row of its own kind and update it", async () => {
  const server = await createThreadServer();
  const { ctx } = server;
  const threadId = await server.spawn();
  const builds = ctx.kernel.scope("builds", "installed");
  const first = await builds.call(threadOps.addRow, {
    threadId,
    kind: "ci-run",
    title: "CI running",
    status: "pending",
    data: { passed: 3, total: 10 },
  });
  await builds.call(threadOps.addRow, {
    threadId,
    id: first.id,
    kind: "ci-run",
    title: "CI passed",
    detail: "10 of 10 checks",
    data: { passed: 10, total: 10 },
  });
  type Row = { kind: string; children?: Row[] | null; plugin?: object };
  const timeline = await server.read<{ rows: Row[] }>(
    `/threads/${threadId}/timeline`,
  );
  const flat = (rows: Row[]): Row[] =>
    rows.flatMap((row) => [row, ...flat(row.children ?? [])]);
  const mine = flat(timeline.rows).filter((row) => row.plugin !== undefined);
  expect(mine).toEqual([
    expect.objectContaining({
      kind: "system",
      systemKind: "operation",
      title: "CI passed",
      detail: "10 of 10 checks",
      status: "completed",
      plugin: {
        id: "builds",
        kind: "ci-run",
        data: { passed: 10, total: 10 },
      },
    }),
  ]);
  const headers = { "content-type": "application/json" };
  const body = JSON.stringify({ threadId, kind: "ci-run", title: "x" });
  const posted = { method: "POST", headers, body };
  const direct = await server.request("/ops/threads.addRow", posted);
  expect(direct.status).toBe(403);
});

it("lets plugins keep shared tables, publish one and join another's", async () => {
  const server = await createThreadServer();
  const { ctx } = server;
  const threadId = await server.spawn();
  const tracker = contract("tracker", {
    notes: table<{ thread_id: string }>(),
  });
  const failures: string[] = [];
  const attempt = (work: () => unknown) => {
    try {
      work();
    } catch (error) {
      failures.push((error as Error).message);
    }
  };
  const owner = (bb: PluginServerApi) => {
    const { tables } = bb.storage;
    const notes = tables.name("notes");
    const create = `CREATE TABLE ${notes} (thread_id TEXT, note TEXT)`;
    tables.migrate([create]);
    tables.publish(tracker.notes, "notes");
    bb.db.run(`INSERT INTO ${notes} VALUES (?, ?)`, threadId, "ship it");
    attempt(() => tables.migrate([create, "CREATE TABLE copy (id TEXT)"]));
  };
  let joined: unknown;
  const reader = (bb: PluginServerApi) => {
    const { tables } = bb.storage;
    const notes = tables.of(tracker.notes);
    const all = tables.of(threadOps.table);
    joined = bb.db.all(
      `SELECT n.note, t.status FROM ${notes} n JOIN ${all} t ON t.id = n.thread_id`,
    );
  };
  const builtins = [
    ["tracker", owner] as const,
    ["report", reader] as const,
  ].map(([name, entry]) => {
    const directory = join(scratch(), name);
    mkdirSync(directory);
    const manifest = { name: `bb-plugin-${name}`, bb: { name } };
    writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
    return { directory, server: entry };
  });
  const host = new PluginHost({ ...ctx.plugins.options, builtins });
  await host.reload();
  const states = host.list().map(({ id, status }) => [id, status]);
  expect(states).toEqual([
    ["tracker", "running"],
    ["report", "running"],
  ]);
  expect(joined).toEqual([{ note: "ship it", status: expect.any(String) }]);
  expect(failures).toEqual([
    expect.stringContaining("Table migration 1 touches a table"),
  ]);
  const kept = ctx.db.all("SELECT note FROM p_tracker_notes");
  expect(kept).toEqual([{ note: "ship it" }]);
  await host.stop();
});

it("gives a plugin the full client, acting as whoever called it", async () => {
  const server = await createThreadServer();
  const { ctx } = server;
  const threadId = await server.spawn();
  await server.settle();
  const helper = contract("helper", {
    tidy: op({
      input: z.object({ threadId: z.string() }),
      output: z.number(),
      kind: "write",
    }),
  });
  const entry = (bb: PluginServerApi) => {
    bb.implement(helper.tidy, async (input) => {
      const projects = await bb.sdk.projects.list();
      await bb.sdk.threads.archive({ threadId: input.threadId });
      return projects.length;
    });
  };
  const directory = join(scratch(), "helper");
  mkdirSync(directory);
  const manifest = { name: "bb-plugin-helper", bb: { name: "Helper" } };
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  const host = new PluginHost({
    ...ctx.plugins.options,
    builtins: [{ directory, server: entry }],
  });
  host.fetch = ctx.plugins.fetch;
  await host.reload();
  const called = await server.http("POST", "/ops/helper.tidy", { threadId });
  expect(called).toMatchObject({ status: 200, body: { result: 1 } });
  const archived = (await auditOf(server)).find(
    (entry) => entry.op === "threads.archive",
  );
  expect(archived).toMatchObject({
    userId: "usr_owner",
    via: ["helper"],
    outcome: "ok",
  });
  await host.stop();
});
