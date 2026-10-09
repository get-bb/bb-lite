import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  API_VERSION,
  contract,
  event,
  files,
  live,
  appearance,
  op,
  plugins as hostOps,
  server as hostServices,
  sessions,
  terminals,
  threads,
  type PluginServerApi,
} from "@bb/plugin";
import type { InstalledPlugin, ThreadResponse } from "@bb/server-contract";
import { transform } from "esbuild";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { cronMatches, parseCron } from "../src/plugins/cron.js";
import { insertRow } from "@bb/server-kit/db/index";
import { runAs } from "@bb/server-kit/auth/actor";
import { PluginHost } from "../src/plugins/host.js";
import { PluginSettings } from "../src/plugins/settings.js";
import { createProject, createTestServer, scratch } from "./helpers.js";

type Listing = { plugins: InstalledPlugin[] };
type Contributions = { cliCommands: unknown[] };
type OpBody = { result?: unknown; code?: string; message?: string };
type CliBody = { stderr: string };

const FIXTURE = fileURLToPath(
  new URL("./fixtures/echo-plugin", import.meta.url),
);
const MACHINE = { "x-bb-via-tunnel": "1", "x-bb-gate-auth": "machine" };
const probe = contract("probe", {
  shout: op({
    input: z.object({ text: z.string() }),
    output: z.string(),
    doors: {
      agent: {
        name: "Shout",
        description: "Shouts",
        instructions: "Use Shout sparingly.",
        enabledFor: ({ providerId }) => providerId === "codex",
      },
    },
  }),
});

async function serverWithEcho(directory = FIXTURE) {
  const server = await createTestServer();
  const { ctx } = server;
  const configFile = join(ctx.config.dataDir, "config.json");
  writeFileSync(configFile, JSON.stringify({ plugins: [{ path: directory }] }));
  await ctx.plugins.reload();
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await server.request(`/plugins${path}`, init);
    const text = await response.text();
    const json = response.headers.get("content-type")?.includes("json");
    const body: unknown = json ? JSON.parse(text) : undefined;
    return { status: response.status, text, body, response };
  };
  const send = (path: string, body: unknown, extra = {}, method = "POST") => {
    const headers = { "content-type": "application/json", ...extra };
    return request(path, { method, headers, body: JSON.stringify(body) });
  };
  const answer = async (name: string, input: unknown, extra = {}) => {
    const headers = { "content-type": "application/json", ...extra };
    const init = { method: "POST", headers, body: JSON.stringify(input) };
    const response = await server.request(`/ops/${name}`, init);
    return { status: response.status, ...((await response.json()) as OpBody) };
  };
  const call = async (name: string, input: unknown) => {
    const { status, result, code } = await answer(name, input);
    return [status, result ?? code];
  };
  const kv = (key: string) =>
    ctx.db.get<{ value: string }>(
      "SELECT value FROM plugin_kv WHERE plugin_id = 'echo' AND key = ?",
      key,
    )?.value;
  return { ...server, server, configFile, request, send, answer, call, kv };
}

it("loads the builtin table and the directories named in config.json", async () => {
  const { request, ctx } = await serverWithEcho();
  const { plugins } = (await request("")).body as Listing;
  const summary = plugins.map((plugin) => [
    plugin.id,
    plugin.status,
    plugin.app?.kind,
    plugin.cliCommands[0]?.name,
    plugin.icon,
  ]);
  const icon = "/api/v1/plugins/echo/assets/icon.svg";
  const list = ["thread-list", "running", "builtin", undefined, "ListView"];
  expect(summary).toContainEqual(list);
  expect(summary.at(-1)).toEqual(["echo", "running", "external", "echo", icon]);
  expect(plugins.at(-1)).toMatchObject({ enabled: true, hasSettings: true });
  const served = await request("/echo/assets/icon.svg");
  expect(served.response.headers.get("content-type")).toBe("image/svg+xml");
  expect((await request("/echo/assets/server.ts")).status).toBe(404);
  expect((await request("/echo/assets/..%2F..%2Ficon.svg")).status).toBe(404);
  const contributed = (await request("/contributions")).body as Contributions;
  const say = { pluginId: "echo", commands: [{ name: "say" }] };
  expect(contributed.cliCommands.at(-1)).toMatchObject(say);
  const skills = expect.stringMatching(/tasks\/skills$/u);
  expect(ctx.plugins.skillDirs()).toContainEqual(skills);
});

it("validates operation calls, stores data and signals changes", async () => {
  const { answer, call, socket, kv } = await serverWithEcho();
  const client = await socket();
  const echoed = { text: "hello there", calls: 1 };
  expect(await call("echo.echo", { text: "there" })).toEqual([200, echoed]);
  const signal = { type: "plugin-signal", pluginId: "kernel" };
  const payload = { name: "echo.echo" };
  expect(await client.next()).toEqual({
    ...signal,
    channel: "changed",
    payload,
  });
  expect(kv("last")).toBe('"there"');
  const invalidRequest = [400, "invalid_request"];
  expect(await call("echo.echo", { text: 1 })).toEqual(invalidRequest);
  expect(await call("echo.absent", {})).toEqual([404, "not_found"]);
  expect(await call("echo.later", {})).toEqual([501, "unimplemented"]);
  expect(await call("echo.fail", {})).toEqual([500, "handler_error"]);
  expect(await call("absent.echo", {})).toEqual([404, "not_found"]);
  const invalid = await answer("echo.echo", {});
  expect(invalid.message).toContain("text");
});

it("guards plugin http routes by their declared auth mode", async () => {
  const { request, send, answer } = await serverWithEcho();
  const status = async (path: string, headers = {}) =>
    (await request(`/echo/http/${path}`, { headers })).status;
  expect((await request("/echo/http/local")).body).toEqual({ auth: "local" });
  expect(await status("local", MACHINE)).toBe(403);
  expect(await status("none", MACHINE)).toBe(200);
  const fromMachine = await answer("echo.echo", { text: "m" }, MACHINE);
  expect(fromMachine.status).toBe(200);
  expect(await status("token")).toBe(401);
  expect((await send("/echo/token", {}, MACHINE)).status).toBe(403);
  const { token } = (await send("/echo/token", {})).body as { token: string };
  expect(await status("token", { "x-bb-plugin-token": token })).toBe(200);
  expect(await status(`token?token=${token}`, MACHINE)).toBe(200);
  expect(await status("token?token=wrong")).toBe(401);
  await send("/echo/token", { rotate: true });
  expect(await status(`token?token=${token}`)).toBe(401);
  expect(await status("absent")).toBe(404);
});

it("stores settings and never returns a secret", async () => {
  const { request, send, call, ctx } = await serverWithEcho();
  const save = (values: object, headers = {}) =>
    send("/echo/settings", { values }, headers, "PUT");
  expect((await request("/echo/settings")).body).toMatchObject({
    schema: { apiKey: { type: "string", secret: true } },
    values: { greeting: "hello", apiKey: { set: false } },
  });
  const update = { greeting: "hi", apiKey: "s3cret" };
  expect((await save(update, MACHINE)).status).toBe(403);
  const saved = await save(update);
  const values = { greeting: "hi", apiKey: { set: true } };
  expect(saved.body).toMatchObject({ ok: true, values });
  expect(saved.text + (await request("")).text).not.toContain("s3cret");
  const file = join(ctx.config.dataDir, "plugins/echo/secrets/apiKey");
  expect(readFileSync(file, "utf8")).toBe("s3cret");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const greeted = { text: "hi you", calls: 1 };
  expect(await call("echo.echo", { text: "you" })).toEqual([200, greeted]);
  expect((await save({ greeting: 5 })).status).toBe(400);
  expect((await save({ unknown: "x" })).status).toBe(400);
});

it("restarts a crashed service and disposes a disabled plugin", async () => {
  const { send, request, call, kv } = await serverWithEcho();
  await vi.waitFor(() => expect(kv("starts")).toBe("2"), { timeout: 5_000 });
  expect(kv("disposed")).toBeUndefined();
  expect((await send("/echo/disable", {}, MACHINE)).status).toBe(403);
  const plugin = { enabled: false, status: "disabled", cliCommands: [] };
  const disabled = await send("/echo/disable", {});
  expect(disabled.body).toMatchObject({ ok: true, plugin });
  expect(kv("disposed")).toBe("true");
  const unimplemented = [501, "unimplemented"];
  expect(await call("echo.echo", { text: "x" })).toEqual(unimplemented);
  expect((await request("/echo/http/none")).status).toBe(503);
  const scope = { argv: ["say", "x"], cwd: "/work", threadId: "thr_1" };
  const { stderr } = (await send("/echo/cli", scope)).body as CliBody;
  expect(stderr).toContain("not running");
  const enabled = await send("/echo/enable", {});
  expect(enabled.body).toMatchObject({ plugin: { status: "running" } });
  expect((await call("echo.echo", { text: "x" }))[0]).toBe(200);
});

it("reloads a changed external plugin and refuses rewritten migrations", async () => {
  const directory = join(scratch(), "echo");
  cpSync(FIXTURE, directory, { recursive: true });
  const { send, call, configFile } = await serverWithEcho(directory);
  const source = join(directory, "server.ts");
  const edit = (from: string, to: string) =>
    writeFileSync(source, readFileSync(source, "utf8").replace(from, to));
  const reload = async (id?: string): Promise<InstalledPlugin[]> =>
    ((await send("/reload", { id })).body as Listing).plugins;
  await call("echo.echo", { text: "a" });
  edit('default: "hello"', 'default: "howdy"');
  edit('NOT NULL)"]', 'NOT NULL)", "CREATE TABLE extra (id INTEGER)"]');
  await reload("echo");
  const echoed = { text: "howdy b", calls: 2 };
  expect(await call("echo.echo", { text: "b" })).toEqual([200, echoed]);
  edit("extra (id INTEGER)", "extra (id TEXT)");
  const statusMessage = expect.stringContaining("Migration 1 changed");
  const failed = { status: "error", statusMessage };
  expect((await reload()).at(-1)).toMatchObject(failed);
  writeFileSync(configFile, JSON.stringify({ plugins: [] }));
  expect((await reload()).map((plugin) => plugin.id)).not.toContain("echo");
});

it("loads a plugin only on the API and plugin versions it names", async () => {
  const directory = join(scratch(), "echo");
  cpSync(FIXTURE, directory, { recursive: true });
  const file = join(directory, "package.json");
  const original = JSON.parse(readFileSync(file, "utf8")) as { bb: object };
  const declare = (engines: string, requires: object = []) => {
    const bb = { ...original.bb, requires };
    const next = { ...original, engines: { bb: engines }, bb };
    writeFileSync(file, JSON.stringify(next));
  };
  declare("^99");
  const { send } = await serverWithEcho(directory);
  const echo = async () => {
    const { plugins } = (await send("/reload", {})).body as Listing;
    const { status, statusMessage } = plugins.find(({ id }) => id === "echo")!;
    return [status, statusMessage ?? ""].join(" ").trim();
  };
  const here = `this bb has ${API_VERSION}`;
  expect(await echo()).toBe(`error needs plugin API ^99; ${here}`);
  declare(`^${API_VERSION}`, ["threads"]);
  expect(await echo()).toBe("running");
  declare(">=1", { threads: "^99" });
  expect(await echo()).toContain('error requires "threads" ^99; it is ');
});

it("serves an external app bundle whose shared imports resolve at runtime", async () => {
  const { request, url } = await serverWithEcho();
  const app = ((await request("")).body as Listing).plugins.at(-1)?.app;
  if (app?.kind !== "external") throw new Error("echo has no external app");
  const script = await fetch(`${url}${app.jsUrl}`);
  expect(script.headers.get("content-type")).toContain("text/javascript");
  expect(script.headers.get("cache-control")).toContain("immutable");
  const styles = await fetch(`${url}${app.cssUrl}`);
  expect(await styles.text()).toContain(".echo-panel");
  const { code } = await transform(await script.text(), { format: "cjs" });
  const jsx = (type: unknown, props: unknown): unknown => ({ type, props });
  const useState = (value: number) => [value];
  const clsx = (...names: string[]) => names.join(" ");
  const callOp = vi.fn();
  type Rendered = { props: { onClick(): void } };
  type Panel = { view(): Rendered };
  const navPanel = { name: "shell.navPanel" };
  const sandbox = {
    module: { exports: {} as { default?: (bb: unknown) => void } },
    __bbPluginRuntime: {
      react: { default: { useState }, useState },
      "react/jsx-runtime": { jsx },
      clsx: { default: clsx, clsx },
      "@bb/plugin/app": { shell: { navPanel }, callOp },
    },
  };
  vm.runInNewContext(code, sandbox);
  const panels: Panel[] = [];
  const add = (slot: unknown, panel: Panel) => {
    if (slot === navPanel) panels.push(panel);
  };
  sandbox.module.exports.default?.({ add });
  const props = { className: "echo-panel flex", children: 3 };
  const rendered = panels[0]?.view();
  expect(rendered).toMatchObject({ type: "div", props });
  rendered?.props.onClick();
  const called = expect.objectContaining({ name: "echo.echo", kind: "write" });
  expect(callOp).toHaveBeenCalledWith(called, { text: "panel" });
});

it("compiles the classes an external app adds into one sheet with the host's", async () => {
  const stock = await serverWithEcho();
  const listed = ((await stock.request("")).body as Listing).plugins.at(-1);
  expect(listed?.app).toMatchObject({ kind: "external", utilitiesUrl: null });
  const directory = join(scratch(), "echo");
  cpSync(FIXTURE, directory, { recursive: true });
  const source = join(directory, "app.tsx");
  const added = '"flex", "bg-fuchsia-300", "md:bg-fuchsia-400"';
  writeFileSync(source, readFileSync(source, "utf8").replace('"flex"', added));
  const { request, url } = await serverWithEcho(directory);
  const app = ((await request("")).body as Listing).plugins.at(-1)?.app;
  if (app?.kind !== "external") throw new Error("echo has no external app");
  const sheet = await (await fetch(`${url}${app.utilitiesUrl}`)).text();
  const wide = sheet.indexOf(".md\\:bg-fuchsia-400");
  expect(sheet).toContain(".flex {");
  expect(sheet.indexOf(".bg-fuchsia-300")).toBeGreaterThan(0);
  expect(wide).toBeGreaterThan(sheet.indexOf(".bg-fuchsia-300"));
  expect(wide).toBeGreaterThan(sheet.lastIndexOf("\n  .flex {"));
});

it("answers the thread engine's queries from what plugins register", async () => {
  const { ctx } = await createTestServer();
  const directory = scratch();
  const manifest = { name: "bb-plugin-probe", bb: { name: "Probe" } };
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  const idleTexts: (string | null)[] = [];
  const server = (bb: PluginServerApi) => {
    bb.implement(probe.shout, ({ text }) => text.toUpperCase());
    bb.on(sessions.instructions, async ({ threadId }, next) => {
      const own = { source: bb.pluginId, text: `Thread ${threadId}` };
      return [...(await next()), own];
    });
    bb.on(sessions.env, { providerId: "codex" }, async ({ hostId }, next) => {
      const value = { serverPath: `/pool/${hostId}` };
      return [{ name: "POOL_URL", value }, ...(await next())];
    });
    bb.on(threads.idle, ({ lastAssistantText }) => {
      idleTexts.push(lastAssistantText);
    });
    bb.add(sessions.mention, {
      id: "note",
      label: "Notes",
      search: ({ query }) => [{ id: "n1", title: `Note ${query}` }],
      resolve: (id) => ({ context: `Body of ${id}` }),
    });
    const complete = async (prompt: string) => ` ${prompt.slice(0, 5)} `;
    bb.add(sessions.inference, { id: "tiny", displayName: "Tiny", complete });
    bb.status.needsConfiguration("Sign in first");
  };
  const plugins = new PluginHost({
    ...ctx.plugins.options,
    builtins: [{ directory, server }],
  });
  await plugins.reload();
  const signal = new AbortController().signal;
  const thread = { threadId: "thr_1", projectId: "proj_1", hostId: "host_1" };
  const codex = { ...thread, providerId: "codex", signal };
  const status = "needs-configuration";
  const waiting = { id: "probe", status, statusMessage: "Sign in first" };
  expect(plugins.list()).toMatchObject([waiting]);
  const { kernel } = ctx;
  const sections = await kernel.call(sessions.instructions, codex);
  const instructions = ["Use Shout sparingly.", "Thread thr_1"];
  expect(sections.map(({ text }) => text)).toEqual(instructions);
  const claude = { ...codex, providerId: "claude-code" };
  expect(await kernel.call(sessions.tools, claude)).toEqual([]);
  const inputSchema = { type: "object", required: ["text"] };
  const tool = { name: "Shout", inputSchema };
  expect(await kernel.call(sessions.tools, codex)).toMatchObject([tool]);
  const contentItems = [{ type: "inputText", text: "HI" }];
  const shout = (input: unknown) =>
    kernel.call(hostOps.callAgentTool, {
      name: "Shout",
      input,
      context: codex,
    });
  expect(await shout({ text: "hi" })).toEqual({ contentItems, success: true });
  expect((await shout({})).success).toBe(false);
  const env = [{ name: "POOL_URL", value: { serverPath: "/pool/host_1" } }];
  expect(await kernel.call(sessions.env, codex)).toEqual(env);
  const idle = { thread: {} as ThreadResponse, lastAssistantText: "done" };
  kernel.emit(threads.idle, idle);
  expect(idleTexts).toEqual(["done"]);
  const query = { query: "x", projectId: null, threadId: null };
  const item = { itemId: "note:n1", title: "Note x", subtitle: null };
  const group = { pluginId: "probe", providerId: "note", label: "Notes" };
  const search = (trigger: "@" | "#") =>
    kernel.call(sessions.searchMentions, { trigger, ...query });
  const found = await search("@");
  expect(found).toMatchObject([{ ...group, items: [item] }]);
  expect(await search("#")).toEqual([]);
  const titled = await kernel.call(sessions.title, { prompt: "Hello world" });
  expect(titled).toBe("Hello");
});

it("aims live values, changes and events at one user's apps", async () => {
  const { ctx } = await createTestServer();
  const directory = scratch();
  const manifest = { name: "bb-plugin-aimed", bb: { name: "Aimed" } };
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  const aimed = contract("aimed", {
    note: live(z.string().nullable()),
    list: op({ input: z.object({}), output: z.array(z.string()) }),
    pinged: event(z.object({ text: z.string() })),
  });
  let api: PluginServerApi | undefined;
  const server = (bb: PluginServerApi) => {
    api = bb;
    bb.status.needsConfiguration("Pick a channel");
  };
  const plugins = new PluginHost({
    ...ctx.plugins.options,
    builtins: [{ directory, server }],
  });
  await plugins.reload();
  if (api === undefined) throw new Error("the plugin did not start");
  const bb = api;
  expect(plugins.list()).toMatchObject([{ status: "needs-configuration" }]);
  bb.status.ready();
  expect(plugins.list()[0]?.status).not.toBe("needs-configuration");
  const frames = { usr_a: [] as unknown[], usr_b: [] as unknown[] };
  for (const user of ["usr_a", "usr_b"] as const) {
    const send = (data: string) => {
      const frame = JSON.parse(data) as { type: string };
      if (frame.type === "plugin-signal") frames[user].push(frame);
    };
    ctx.hub.connect({ send, close: () => {} }, user);
  }
  const note = bb.provide(aimed.note, null);
  note.set("for a", { userId: "usr_a" });
  bb.changed(aimed.list, { userId: "usr_a" });
  bb.emit(aimed.pinged, { text: "hi" }, { userId: "usr_a" });
  const kernel = (payload: object) => ({ pluginId: "kernel", payload });
  expect(frames.usr_b).toEqual([]);
  expect(frames.usr_a).toMatchObject([
    kernel({ name: "aimed.note" }),
    kernel({ name: "aimed.list" }),
    kernel({ name: "aimed.pinged", payload: { text: "hi" } }),
  ]);
  const as = (userId: string) =>
    ({ userId, role: "member", agentThreadId: null }) as const;
  const read = (user: string) =>
    runAs(as(user), () => ctx.kernel.value(aimed.note));
  expect([read("usr_a"), read("usr_b")]).toEqual(["for a", null]);
  const settings = bb.settings.define(
    { quiet: { type: "boolean", label: "Quiet", default: false } },
    { scope: "user" },
  );
  await runAs(as("usr_a"), () => settings.set({ quiet: true }));
  expect((await settings.get({ userId: "usr_a" })).quiet).toBe(true);
  expect((await settings.get({ userId: "usr_b" })).quiet).toBe(false);
  expect((await settings.get()).quiet).toBe(false);
});

it("accepts a project setting only when it names a project", async () => {
  const server = await createTestServer();
  const project = await createProject(server, "picked");
  const { ctx } = server;
  const settings = new PluginSettings(ctx.db, "picker", join(scratch(), "s"));
  const target = { type: "project", label: "Target" } as const;
  settings.define({ target }, "workspace");
  await settings.write({ target: project.id });
  expect(await settings.read()).toEqual({ target: project.id });
  await expect(settings.write({ target: "proj_missing" })).rejects.toThrow(
    "names no project",
  );
  await expect(settings.write({ target: 4 })).rejects.toThrow("Invalid value");
});

it("stores project-scoped settings per project", async () => {
  const server = await createTestServer();
  const one = await createProject(server, "one");
  const two = await createProject(server, "two");
  const { ctx } = server;
  const settings = new PluginSettings(ctx.db, "per-proj", join(scratch(), "s"));
  const lint = { type: "boolean", label: "Lint", default: false } as const;
  settings.define({ lint }, "project");
  expect(settings.descriptors.lint).toMatchObject({ scope: "project" });
  await settings.write({ lint: true }, null, one.id);
  expect(await settings.read(null, one.id)).toEqual({ lint: true });
  expect(await settings.read(null, two.id)).toEqual({ lint: false });
  expect(await settings.read()).toEqual({ lint: false });
  expect(settings.isPersonal(["lint"], one.id)).toBe(true);
  expect(settings.isPersonal(["lint"])).toBe(false);
  await expect(
    settings.write({ lint: true }, null, "proj_missing"),
  ).rejects.toThrow("Unknown project");
});

it("accepts select and number settings and refuses values outside them", async () => {
  const { ctx } = await createTestServer();
  const settings = new PluginSettings(ctx.db, "tuner", join(scratch(), "s"));
  settings.define(
    {
      mode: {
        type: "select",
        label: "Mode",
        options: [
          { value: "fast", label: "Fast" },
          { value: "careful", label: "Careful" },
        ],
        default: "fast",
      },
      retries: {
        type: "number",
        label: "Retries",
        min: 0,
        max: 5,
        integer: true,
      },
    },
    "workspace",
  );
  expect(await settings.read()).toEqual({ mode: "fast", retries: undefined });
  await settings.write({ mode: "careful", retries: 3 });
  expect(await settings.read()).toEqual({ mode: "careful", retries: 3 });
  for (const bad of [{ mode: "reckless" }, { retries: 9 }, { retries: 1.5 }]) {
    await expect(settings.write(bad)).rejects.toThrow("Invalid value");
  }
});

it("lists providers and execution options to plugins", async () => {
  const { ctx } = await createTestServer({}, "echo");
  const probe = ctx.kernel.scope("probe", "installed");
  const providers = await probe.call(sessions.providers, {});
  expect(providers.map(({ id }) => id)).toContain("echo");
  const options = await probe.call(sessions.executionOptions, {
    providerId: "echo",
  });
  expect(options).toHaveProperty("models");
});

it("matches five-field cron expressions", () => {
  const at = (text: string) => new Date(text);
  const weekdays = parseCron("*/15 9-17 * * 1-5");
  expect(cronMatches(weekdays, at("2026-10-08T09:30:00"))).toBe(true);
  expect(cronMatches(weekdays, at("2026-10-08T09:31:00"))).toBe(false);
  expect(cronMatches(weekdays, at("2026-10-10T09:30:00"))).toBe(false);
  expect(cronMatches(parseCron("0 0 1 1 *"), at("2027-01-01T00:00:00"))).toBe(
    true,
  );
  for (const bad of ["* * * *", "61 * * * *", "*/0 * * * *", "a * * * *"]) {
    expect(() => parseCron(bad)).toThrow();
  }
});

it("tells plugins when thread events and queued messages change", async () => {
  const server = await createTestServer({}, "echo");
  const { ctx } = server;
  const watcher = ctx.kernel.scope("watcher", "installed");
  const seen: string[] = [];
  watcher.on(threads.appended, ({ types }) => void seen.push(...types));
  watcher.on(threads.messageQueued, () => void seen.push("queued"));
  watcher.on(sessions.skillDirs, async (_context, next) => [
    ...(await next()),
    "/extra/skills",
  ]);
  const directory = join(ctx.config.dataDir, "repo");
  mkdirSync(directory);
  const project = await createProject(server, "echo", directory);
  const spawned = await server.send("/threads", {
    projectId: project.id,
    origin: "app",
    providerId: "echo",
    input: [{ type: "text", text: "delay:800 first" }],
    environment: { type: "project-default" },
    startedOnBehalfOf: null,
  });
  const { id } = (await spawned.json()) as { id: string };
  await vi.waitFor(() => expect(seen).toContain("turn/started"));
  await server.send(`/threads/${id}/queued-messages`, {
    input: [{ type: "text", text: "second" }],
  });
  await vi.waitFor(() => expect(seen).toContain("queued"));
  const scope = { threadId: id, projectId: project.id, hostId: null };
  const dirs = await watcher.call(sessions.skillDirs, {
    ...scope,
    providerId: "echo",
  });
  expect(dirs.at(-1)).toBe("/extra/skills");
});

it("lets a plugin hold a message until it releases the thread", async () => {
  const server = await createTestServer({}, "echo");
  const { ctx } = server;
  const limiter = ctx.kernel.scope("limiter", "installed");
  let busy = true;
  limiter.on(threads.hold, async (_input, next) => {
    const held = await next();
    if (held !== null || !busy) return held;
    return { pluginId: "limiter", reason: "Too many threads are running" };
  });
  const directory = join(ctx.config.dataDir, "repo");
  mkdirSync(directory);
  const project = await createProject(server, "echo", directory);
  const spawned = await server.send("/threads", {
    projectId: project.id,
    origin: "app",
    providerId: "echo",
    input: [{ type: "text", text: "wait for a slot" }],
    environment: { type: "project-default" },
    startedOnBehalfOf: null,
  });
  const { id } = (await spawned.json()) as { id: string };
  type Queued = { waitingOn: { kind: string; reason?: string } | null };
  const queued = () => server.read<Queued[]>(`/threads/${id}/queued-messages`);
  await vi.waitFor(async () =>
    expect(await queued()).toMatchObject([
      { waitingOn: { kind: "plugin", reason: "Too many threads are running" } },
    ]),
  );
  expect(await server.read(`/threads/${id}/output`)).toEqual({ output: null });
  busy = false;
  await limiter.call(threads.release, { threadId: id });
  await vi.waitFor(async () => {
    const reply = { output: "Response to: wait for a slot" };
    expect(await server.read(`/threads/${id}/output`)).toEqual(reply);
  });
  const where = await limiter.call(threads.storageLocation, { threadId: id });
  expect(where?.path.endsWith(id)).toBe(true);
});

it("tells a hold the machine and message, and releases every hold", async () => {
  const server = await createTestServer({}, "echo");
  const { ctx } = server;
  const limiter = ctx.kernel.scope("limiter", "installed");
  let busy = true;
  const asked: { hostId: string | null; queuedMessageId: string | null }[] = [];
  limiter.on(threads.hold, async (input, next) => {
    asked.push(input);
    const held = await next();
    if (held !== null || !busy) return held;
    return { pluginId: "limiter", reason: "Busy" };
  });
  const directory = join(ctx.config.dataDir, "repo");
  mkdirSync(directory);
  const project = await createProject(server, "echo", directory);
  const spawned = await server.send("/threads", {
    projectId: project.id,
    origin: "app",
    providerId: "echo",
    input: [{ type: "text", text: "hold me" }],
    environment: { type: "project-default" },
    startedOnBehalfOf: null,
  });
  const { id } = (await spawned.json()) as { id: string };
  type Queued = { id: string };
  const queued = () => server.read<Queued[]>(`/threads/${id}/queued-messages`);
  await vi.waitFor(async () => expect(await queued()).toHaveLength(1));
  const [row] = await queued();
  expect(asked[0]).toMatchObject({
    hostId: ctx.config.hostId,
    queuedMessageId: null,
    input: [{ type: "text", text: "hold me" }],
  });
  busy = false;
  await limiter.call(threads.release, {});
  await vi.waitFor(async () => {
    const reply = { output: "Response to: hold me" };
    expect(await server.read(`/threads/${id}/output`)).toEqual(reply);
  });
  expect(asked.at(-1)).toMatchObject({
    hostId: ctx.config.hostId,
    queuedMessageId: row?.id,
  });
});

it("offers the themes a plugin's manifest declares", async () => {
  const directory = join(scratch(), "echo");
  cpSync(FIXTURE, directory, { recursive: true });
  const file = join(directory, "package.json");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as {
    bb: Record<string, unknown>;
  };
  const codeTheme = { dark: "nord" };
  const declared = { ...codeTheme, light: "./themes/light-code.json" };
  const theme = { id: "dusk", name: "Dusk", css: "./dusk.css" };
  const dusk = { ...theme, codeTheme: declared };
  manifest.bb.themes = [dusk];
  writeFileSync(file, JSON.stringify(manifest));
  writeFileSync(join(directory, "dusk.css"), ":root { --canvas: #111; }");
  const started = await serverWithEcho(directory);
  const { request, read, server, configFile, ctx } = started;
  type Config = { themes: unknown[]; appearance: { themeId: string } };
  const config = () => read<Config>("/server/config");
  const cssFile = join(directory, "dusk.css");
  const version = () => Math.trunc(statSync(cssFile).mtimeMs);
  const cssUrl = `/api/v1/plugins/echo/themes/dusk.css?v=${version()}`;
  const id = "plugin:echo:dusk";
  const heard: unknown[] = [];
  ctx.kernel.scope("listener", "installed").on(appearance.changed, (chosen) => {
    heard.push(chosen);
  });
  const listed = { id, pluginId: "echo", name: "Dusk", cssUrl, codeTheme };
  expect((await config()).themes).toEqual([{ ...listed, description: "" }]);
  const css = await request("/echo/themes/dusk.css");
  expect(css.response.headers.get("content-type")).toContain("text/css");
  expect(css.text).toContain("--canvas: #111");
  expect((await request("/echo/themes/dawn.css")).status).toBe(404);
  const choose = (themeId: string) => {
    const selection = { themeId, faviconColor: "default" };
    return server.send("/settings/appearance", selection, "PUT");
  };
  expect((await choose("plugin:echo:dawn")).status).toBe(404);
  expect((await choose(id)).status).toBe(200);
  expect(heard).toEqual([{ themeId: id, faviconColor: "default" }]);
  expect((await config()).appearance.themeId).toBe(id);
  writeFileSync(configFile, JSON.stringify({ plugins: [] }));
  await ctx.plugins.reload();
  expect(await config()).toMatchObject({
    themes: [],
    appearance: { themeId: "default" },
  });
});

it("lists, creates, moves and removes files in a thread's workspace", async () => {
  const server = await createTestServer({}, "echo");
  const { ctx } = server;
  const directory = join(ctx.config.dataDir, "repo");
  mkdirSync(directory);
  writeFileSync(join(directory, "notes.md"), "hello");
  const project = await createProject(server, "echo", directory);
  const spawned = await server.send("/threads", {
    projectId: project.id,
    origin: "app",
    providerId: "echo",
    input: [{ type: "text", text: "files" }],
    environment: { type: "project-default" },
    startedOnBehalfOf: null,
  });
  const { id: threadId } = (await spawned.json()) as { id: string };
  await vi.waitFor(async () => {
    const reply = { output: "Response to: files" };
    expect(await server.read(`/threads/${threadId}/output`)).toEqual(reply);
  });
  const plugin = ctx.kernel.scope("filer", "installed");
  const names = async (path?: string) => {
    const listed = await plugin.call(files.list, { threadId, path });
    return listed.paths.map(({ name }) => name).sort();
  };
  expect(await names()).toEqual(["notes.md"]);
  await plugin.call(files.mkdir, { threadId, path: "drafts/old" });
  await plugin.call(files.move, {
    threadId,
    from: "notes.md",
    to: "drafts/notes.md",
  });
  expect(await names("drafts")).toEqual(["notes.md"]);
  expect(existsSync(join(directory, "drafts", "old"))).toBe(true);
  const old = { threadId, path: "drafts/old" };
  await plugin.call(files.delete, { ...old, recursive: true });
  expect(existsSync(join(directory, "drafts", "old"))).toBe(false);
  const missing = { terminalId: "term_missing", cols: 80, rows: 24 };
  await expect(plugin.call(terminals.resize, missing)).rejects.toThrow(
    "Terminal session not found",
  );
});

it("gives any plugin the host services core plugins are built on", async () => {
  const server = await createTestServer();
  const { ctx } = server;
  const directory = join(scratch(), "outsider");
  mkdirSync(directory);
  const manifest = { name: "bb-plugin-outsider", bb: { name: "Outsider" } };
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  const changed: string[] = [];
  const count = "SELECT count(*) AS total FROM projects";
  const entry = (bb: PluginServerApi) => {
    bb.http.api((app) => {
      app.get("/outsider/summary", (c) => {
        const { hostId } = bb.server;
        const projects = bb.db.get<{ total: number }>(count)?.total;
        const connected = bb.runners.isConnected(hostId);
        return c.json({ projects, hostId, connected, at: bb.now() });
      });
    });
    bb.onDispose(bb.realtime.onChanged(({ entity }) => changed.push(entity)));
  };
  const plugins = new PluginHost({
    ...ctx.plugins.options,
    builtins: [{ directory, server: entry }],
  });
  await plugins.reload();
  const projects = ctx.db.get<{ total: number }>(count)?.total;
  expect(projects).toBeGreaterThan(0);
  const { hostId } = ctx.config;
  const summary = { projects, hostId, connected: true, at: server.clock.now };
  expect(await server.read("/outsider/summary")).toEqual(summary);
  const quiet = changed.length;
  ctx.hub.system(["config-changed"]);
  expect(changed.slice(quiet)).toEqual(["system"]);
  await plugins.stop();
  expect((await server.request("/outsider/summary")).status).toBe(404);
  const heard = changed.length;
  ctx.hub.system(["config-changed"]);
  expect(changed).toHaveLength(heard);
});

it("lets a plugin decide who a request is from", async () => {
  const server = await createTestServer();
  const { ctx } = server;
  const at = { createdAt: 1, updatedAt: 1 };
  const bo = { id: "usr_bo", name: "Bo", role: "member", externalId: null };
  insertRow(ctx.db, "users", { ...bo, ...at });
  const session = async (headers: Record<string, string> = {}) => {
    const response = await server.request("/auth/session", { headers });
    return ((await response.json()) as { user: { id: string } | null }).user
      ?.id;
  };
  const owner = await session();
  expect(await session({ "x-badge": "bo" })).toBe(owner);
  const builtIn = ctx.kernel.use(hostServices.authenticator);
  const badges = ctx.kernel.scope("badges", "installed");
  badges.add(hostServices.authenticator, {
    ...builtIn,
    principal(request) {
      if (request.headers["x-badge"] !== "bo")
        return builtIn.principal(request);
      const member = { userId: "usr_bo", role: "member" as const };
      return { kind: "user", ...member, implicit: false };
    },
  });
  expect(await session({ "x-badge": "bo" })).toBe("usr_bo");
  expect(await session()).toBe(owner);
  badges.dispose();
  expect(await session({ "x-badge": "bo" })).toBe(owner);
});
