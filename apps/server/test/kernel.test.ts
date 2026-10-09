import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_VERSION,
  contract,
  deny,
  live,
  op,
  sessions,
  table,
  projects as projectOps,
  threads as threadOps,
  type Op,
  type PluginServerApi,
  plugins as hostOps,
  majorOf,
  event,
} from "@bb/plugin";
import { createThreadRequestSchema } from "@bb/server-contract";
import { createRunnerPlugins } from "@bb/runner";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { runAs } from "@bb/server-kit/auth/actor";
import { pruneAudit } from "@bb/server-kit/db/audit";
import { currentCaller, enterCaller } from "@bb/server-kit/kernel/caller";
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

it("records the app plugin a client names, without giving it authority", async () => {
  const server = await createThreadServer();
  const json = { "content-type": "application/json" };
  const named = { ...json, ...APP, "x-bb-app-plugin": "thread-list" };
  const create = (headers: Record<string, string>, name: string) =>
    server.request("/sections", {
      method: "POST",
      headers,
      body: JSON.stringify({ name }),
    });
  expect((await create(named, "From the app")).status).toBe(201);
  expect(
    (
      await create(
        { ...json, ...named, ...{ "x-bb-door": "cli" } },
        "From the CLI",
      )
    ).status,
  ).toBe(201);
  const trail = (await auditOf(server)).map((entry) => [entry.door, entry.via]);
  expect(trail).toEqual([
    ["app", ["app:thread-list"]],
    ["cli", []],
  ]);
  const machine = { "x-bb-via-tunnel": "1", "x-bb-gate-auth": "machine" };
  const refused = await server.request("/machines", {
    method: "POST",
    headers: { ...named, ...machine },
    body: "{}",
  });
  expect(refused.status).toBe(403);
});

it("records a machine write with its caller and hears a machine's events", async () => {
  const server = await createThreadServer();
  const { ctx, runner } = server;
  const written = { outcome: "written", sha256: "abc", sizeBytes: 5 } as const;
  runner.script.writeFile = async () => written;
  const file = { path: "/tmp/notes.txt", content: "hello" };
  const sent = await server.http("POST", "/machines/files/write", file);
  expect(sent).toMatchObject({ status: 200, body: { outcome: "written" } });
  const trail = (await auditOf(server)).map((entry) => {
    const { op, userId, via, input } = entry;
    return { op, userId, via, input: JSON.parse(input ?? "null") as unknown };
  });
  const hostId = ctx.config.hostId;
  expect(trail).toEqual([
    {
      op: "machineFiles.write",
      userId: "usr_owner",
      via: ["workspace"],
      input: { hostId, path: "/tmp/notes.txt", content: "[secret]" },
    },
    {
      op: "machines.writeFile",
      userId: "usr_owner",
      via: [],
      input: { path: "/tmp/notes.txt", content: "hello" },
    },
  ]);
  const probe = contract("probe", {
    low: event(z.object({ freeBytes: z.number() })),
  });
  const heard: unknown[] = [];
  ctx.kernel
    .scope("probe", "installed")
    .on(probe.low, ({ freeBytes }, origin) =>
      heard.push([freeBytes, origin.hostId]),
    );
  const announced = { kind: "plugin.event", name: "probe.low" } as const;
  runner.emit({ lane: "live", ...announced, payload: { freeBytes: 3 } });
  runner.emit({ lane: "live", ...announced, payload: { freeBytes: "x" } });
  await vi.waitFor(() => expect(heard).toEqual([[3, hostId]]));
});

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
  const described = await server.http("POST", "/ops/plugins.contracts", {
    contractId: "tasks",
  });
  expect(described.body).toMatchObject({
    result: { contracts: [{ id: "tasks", plugin: "tasks" }] },
  });
  const located = await server.http("POST", "/ops/plugins.describe", {
    id: "tasks",
  });
  expect(located.body).toMatchObject({
    result: { uses: { declares: ["tasks"] } },
  });
  for (const name of ["threads.hold", "threads.addRow", "files.write"]) {
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
  const refused = [
    "POST /machines",
    "POST /ops/machines.create",
    "PUT /settings/general",
    "POST /users/invites",
    "DELETE /machines/host_1",
    "PATCH /users/usr_owner",
    "PUT /projects/prj_1/machine-environment",
  ];
  for (const route of refused) {
    const [method, path = ""] = route.split(" ");
    const headers = { ...json, ...machine };
    const answer = await server.request(path, { method, headers, body: "{}" });
    expect([route, answer.status]).toEqual([route, 403]);
  }
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
  const offered = { owner: "threads", kind: "write", doors: ["app", "http"] };
  expect(send).toMatchObject(offered);
  const held = body.ops.find(({ name }) => name === "threads.hold");
  expect(held).toMatchObject({ owner: "threads", doors: [] });
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

it("lets a plugin call core operations, acting as whoever called it", async () => {
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
      const listed = await bb.call(projectOps.list, {});
      await bb.call(threadOps.archive, { threadId: input.threadId });
      return listed.length;
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

it("names every core contract member after its export and by one set of verbs", async () => {
  const server = await import("@bb/plugin");
  const app = await import("@bb/plugin/app");
  const exported = Object.entries({ ...server, ...app });
  const kinds = ["op", "event", "slot", "live"];
  type Member = { type: string; name: string };
  const membersOf = (value: unknown): [string, Member][] => {
    if (typeof value !== "object" || value === null) return [];
    const entries = Object.entries(value as Record<string, Member>);
    const isContract =
      entries.length > 0 &&
      entries.every(([, member]) => kinds.includes(member?.type));
    return isContract ? entries : [];
  };
  const misnamed: string[] = [];
  let checked = 0;
  let routed = 0;
  for (const [contractName, value] of exported) {
    for (const [key, member] of membersOf(value)) {
      checked += 1;
      const expected = `${contractName}.${key}`;
      if (member.name !== expected)
        misnamed.push(`${member.name} is exported as ${expected}`);
      const oldVerb = member.type === "op" && /^(remove|drop|edit)/u.test(key);
      const noun = member.type === "event" && ["signal", "input"].includes(key);
      if (oldVerb || noun)
        misnamed.push(`${member.name} breaks the naming rule`);
      const path = (member as Partial<Op>).doors?.http?.path;
      if (path === undefined) continue;
      routed += 1;
      const home = contractName === "interactions" ? "threads" : contractName;
      const [, first = ""] = path.split("/");
      const params = path.split("/").filter((part) => part.startsWith(":"));
      const unnamed = params.filter(
        (part) => !/^:(key|[a-z]+Id)$/iu.test(part),
      );
      if (first !== home || unnamed.length > 0)
        misnamed.push(`${member.name} is served at ${path}`);
    }
  }
  expect(misnamed).toEqual([]);
  expect(checked).toBeGreaterThan(120);
  expect(routed).toBeGreaterThan(120);
});

it("answers an operation at its REST path with one flat input", async () => {
  const server = await createThreadServer();
  const { ctx } = server;
  const note = z.object({ noteId: z.string() });
  const notes = contract("notes", {
    create: op({
      input: z.object({ title: z.string().min(1) }),
      output: z.object({ noteId: z.string(), title: z.string() }),
      kind: "write",
      audit: false,
      doors: { http: { method: "POST", path: "/notes", status: 201 } },
    }),
    get: op({
      input: note.extend({ limit: z.coerce.number().optional() }),
      output: z.object({ noteId: z.string(), limit: z.number().nullable() }),
      doors: { http: { method: "GET", path: "/notes/:noteId" } },
    }),
    recent: op({
      input: z.object({}),
      output: z.array(z.string()),
      doors: {
        http: { method: "GET", path: "/notes/recent", aliases: ["/memos"] },
      },
    }),
    replace: op({
      input: note.extend({ lines: z.array(z.string()) }),
      output: z.number(),
      kind: "write",
      doors: {
        http: { method: "PUT", path: "/notes/:noteId", body: "lines" },
      },
    }),
    next: op({
      input: note,
      output: z.string().nullable(),
      doors: {
        http: { method: "GET", path: "/notes/:noteId/next", empty: 204 },
      },
    }),
    delete: op({
      input: note,
      output: z.void(),
      kind: "write",
      doors: { http: { method: "DELETE", path: "/notes/:noteId" } },
    }),
  });
  const plugin = ctx.kernel.scope("notes", "installed");
  plugin.implement(notes.create, ({ title }) => ({ noteId: "n1", title }));
  plugin.implement(notes.get, ({ noteId, limit = null }) => ({
    noteId,
    limit,
  }));
  plugin.implement(notes.recent, () => ["n1"]);
  plugin.implement(notes.replace, ({ lines }) => lines.length);
  plugin.implement(notes.next, () => null);
  plugin.implement(notes.delete, () => {});
  const created = await server.http("POST", "/notes", { title: "First" });
  expect(created).toMatchObject({ status: 201, body: { noteId: "n1" } });
  const required = await server.http("POST", "/notes", {});
  expect(required).toMatchObject({
    status: 400,
    body: { message: "Required" },
  });
  const broken = await server.request("/notes", { method: "POST", body: "{" });
  expect(await broken.json()).toMatchObject({
    message: "Invalid JSON request body",
  });
  const read = await server.http("GET", "/notes/n1?limit=5");
  expect(read.body).toEqual({ noteId: "n1", limit: 5 });
  expect((await server.http("GET", "/notes/recent")).body).toEqual(["n1"]);
  expect((await server.http("GET", "/memos")).body).toEqual(["n1"]);
  const speaking = (version: string) =>
    server.request("/notes/recent", { headers: { "x-bb-api": version } });
  const ours = majorOf(API_VERSION) ?? 0;
  expect((await speaking(`${ours}.99.0`)).status).toBe(200);
  const newer = await speaking(`${ours + 1}.0.0`);
  expect(newer.status).toBe(426);
  expect(await newer.json()).toMatchObject({ code: "api_version_mismatch" });
  const replaced = await server.http("PUT", "/notes/n1", ["a", "b"]);
  expect(replaced.body).toBe(2);
  expect((await server.request("/notes/n1/next")).status).toBe(204);
  const deleted = await server.http("DELETE", "/notes/n1");
  expect(deleted).toMatchObject({ status: 200, body: { ok: true } });
  const recorded = (await auditOf(server))
    .filter((entry) => entry.op.startsWith("notes."))
    .map((entry) => `${entry.op} ${entry.door}`);
  expect(recorded.sort()).toEqual(["notes.delete http", "notes.replace http"]);
  plugin.dispose();
  expect((await server.http("GET", "/notes/recent")).status).toBe(404);
  expect(pruneAudit(ctx.db, Number.MAX_SAFE_INTEGER)).toBeGreaterThan(1);
  expect(await auditOf(server)).toEqual([]);
});

it("gives a runner part the same handle as the other parts", async () => {
  const lines: string[] = [];
  const runners = createRunnerPlugins({
    dataDir: scratch(),
    log: (line) => void lines.push(line),
  });
  const ran: string[] = [];
  const part = contract("part", {
    ping: op({ input: z.object({}), output: z.string() }),
  });
  runners.load({
    id: "probe",
    entry(bb) {
      bb.implement(part.ping, () => `pong from ${bb.pluginId}`);
      bb.log.info("loaded", { at: 1 });
      bb.onStart(() => {
        ran.push("started");
        return () => void ran.push("stopped");
      });
      bb.onDispose(() => void ran.push("disposed"));
    },
  });
  await vi.waitFor(() => expect(ran).toEqual(["started"]));
  expect(await runners.callOp("part.ping", {})).toBe("pong from probe");
  expect(lines).toContain('[probe] info: loaded {"at":1}');
  runners.dispose();
  await vi.waitFor(() =>
    expect(ran).toEqual(["started", "stopped", "disposed"]),
  );
});

it("keeps the thread a CLI call names, but an agent's own thread wins", () => {
  const person = { userId: "usr_owner", role: "owner", agentThreadId: null };
  const named = runAs({ ...person, role: "owner" }, () => {
    const caller = { ...currentCaller(), door: "cli", thread: "thr_cli" };
    return enterCaller({ ...caller, door: "cli" }, currentCaller);
  });
  expect(named).toMatchObject({ door: "cli", thread: "thr_cli" });
  const agent = { ...person, agentThreadId: "thr_agent" };
  const own = runAs({ ...agent, role: "owner" }, () => {
    const caller = { ...currentCaller(), thread: "thr_other" };
    return enterCaller(caller, currentCaller);
  });
  expect(own).toMatchObject({ door: "agent", thread: "thr_agent" });
});
