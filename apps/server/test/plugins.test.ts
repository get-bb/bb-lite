import {
  cpSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import type { PluginServerApi } from "@bb/plugin";
import type { InstalledPlugin, ThreadResponse } from "@bb/server-contract";
import { transform } from "esbuild";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { PluginHost } from "../src/plugins/host.js";
import { createTestServer } from "./helpers.js";

type Listing = { plugins: InstalledPlugin[] };
type Contributions = { cliCommands: unknown[] };
type RpcBody = { result?: unknown; error?: { code: string; issues?: unknown } };
type CliBody = { exitCode: number; stdout: string; stderr: string };

const FIXTURE = fileURLToPath(
  new URL("./fixtures/echo-plugin", import.meta.url),
);
const MACHINE = { "x-bb-via-tunnel": "1", "x-bb-gate-auth": "machine" };
const scratch = (): string => mkdtempSync(join(tmpdir(), "bb-plugin-test-"));

async function serverWithEcho(directory = FIXTURE) {
  const server = await createTestServer();
  const { ctx, url } = server;
  const configFile = join(ctx.config.dataDir, "config.json");
  writeFileSync(configFile, JSON.stringify({ plugins: [{ path: directory }] }));
  await ctx.plugins.reload();
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${url}/api/v1/plugins${path}`, init);
    const text = await response.text();
    const json = response.headers.get("content-type")?.includes("json");
    const body: unknown = json ? JSON.parse(text) : undefined;
    return { status: response.status, text, body, response };
  };
  const send = (path: string, body: unknown, extra = {}, method = "POST") => {
    const headers = { "content-type": "application/json", ...extra };
    return request(path, { method, headers, body: JSON.stringify(body) });
  };
  const rpc = async (path: string, input: unknown) => {
    const { status, body } = await send(`/${path}`, input);
    const { result, error } = body as RpcBody;
    return [status, result ?? error?.code];
  };
  const cli = async (plugin: string, ...argv: string[]) => {
    const scope = { argv, cwd: "/work", threadId: "thr_1" };
    const { body } = await send(`/${plugin}/cli`, scope);
    const { exitCode, stdout, stderr } = body as CliBody;
    return [exitCode, stdout, stderr] as const;
  };
  const kv = (key: string): string | undefined =>
    ctx.db.get<{ value: string }>(
      "SELECT value FROM plugin_kv WHERE plugin_id = 'echo' AND key = ?",
      key,
    )?.value;
  return { ...server, configFile, request, send, rpc, cli, kv };
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
  expect(summary).toContainEqual([
    "thread-list",
    "running",
    "builtin",
    "thread-list",
    "ListView",
  ]);
  expect(summary.at(-1)).toEqual(["echo", "running", "external", "echo", icon]);
  expect(plugins.at(-1)).toMatchObject({ enabled: true, hasSettings: true });
  const served = await request("/echo/assets/icon.svg");
  expect(served.response.headers.get("content-type")).toBe("image/svg+xml");
  expect((await request("/echo/assets/server.ts")).status).toBe(404);
  expect((await request("/echo/assets/..%2F..%2Ficon.svg")).status).toBe(404);
  const contributed = (await request("/contributions")).body as Contributions;
  const say = { pluginId: "echo", commands: [{ name: "say" }] };
  expect(contributed.cliCommands.at(-1)).toMatchObject(say);
  const skills = expect.stringMatching(/thread-list\/skills$/u);
  expect(ctx.plugins.skillDirs()).toContainEqual(skills);
});

it("validates rpc calls, stores data and broadcasts realtime signals", async () => {
  const { send, rpc, socket, kv } = await serverWithEcho();
  const client = await socket();
  const echoed = { text: "hello there", calls: 1 };
  expect(await rpc("echo/rpc/echo", { text: "there" })).toEqual([200, echoed]);
  const payload = { text: "there" };
  const signal = { type: "plugin-signal", pluginId: "echo", channel: "echoed" };
  expect(await client.next()).toEqual({ ...signal, payload });
  expect(kv("last")).toBe('"there"');
  expect(await rpc("echo/rpc/echo", { text: 1 })).toEqual([
    400,
    "invalid_input",
  ]);
  expect(await rpc("echo/rpc/absent", null)).toEqual([404, "unknown_method"]);
  expect(await rpc("echo/rpc/fail", null)).toEqual([500, "handler_error"]);
  expect(await rpc("absent/rpc/echo", {})).toEqual([404, "plugin_unavailable"]);
  const invalid = (await send("/echo/rpc/echo", {})).body as RpcBody;
  expect(invalid.error?.issues).toMatchObject([{ path: ["text"] }]);
});

it("guards plugin http routes by their declared auth mode", async () => {
  const { request, send } = await serverWithEcho();
  const status = async (path: string, headers = {}): Promise<number> =>
    (await request(`/echo/http/${path}`, { headers })).status;
  expect((await request("/echo/http/local")).body).toEqual({ auth: "local" });
  expect(await status("local", MACHINE)).toBe(403);
  expect(await status("none", MACHINE)).toBe(200);
  const fromMachine = await send("/echo/rpc/echo", { text: "m" }, MACHINE);
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
  const { request, send, rpc, ctx } = await serverWithEcho();
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
  expect(await rpc("echo/rpc/echo", { text: "you" })).toEqual([200, greeted]);
  expect((await save({ greeting: 5 })).status).toBe(400);
  expect((await save({ unknown: "x" })).status).toBe(400);
});

it("dispatches plugin CLI commands inside the server", async () => {
  const { cli } = await serverWithEcho();
  const run = cli.bind(null, "echo");
  const usage =
    "Usage:\n  bb echo say <text> [--times <value>] [--tone <plain|loud>] [--json]";
  expect(await run("say", "hi", "--times", "2", "--tone=loud")).toEqual([
    0,
    "HI HI",
    "",
  ]);
  const [, json] = await run("say", "hi", "--json");
  expect(JSON.parse(json)).toEqual({ said: "hi", threadId: "thr_1" });
  expect((await run("say", "--help"))[1]).toContain(usage);
  expect((await run("--help"))[1]).toContain("bb echo say  Repeat a phrase");
  expect(await run("say", "nothing")).toEqual([3, "", "Nothing to say\n"]);
  const [badTone, , toneError] = await run("say", "hi", "--tone", "soft");
  expect([badTone, toneError]).toEqual([1, expect.stringContaining("loud")]);
  expect((await run("say", "hi", "--times", "x"))[0]).toBe(1);
  expect((await run("shout"))[2]).toContain("unknown command 'shout'");
  const [exitCode, stdout, stderr] = await run("say", "--json");
  const error = { code: "usage", message: "missing <text>" };
  expect([exitCode, JSON.parse(stdout)]).toEqual([1, { ok: false, error }]);
  expect(stderr).toContain(usage);
});

it("restarts a crashed service and disposes a disabled plugin", async () => {
  const { send, request, rpc, cli, kv } = await serverWithEcho();
  await vi.waitFor(() => expect(kv("starts")).toBe("2"), { timeout: 5_000 });
  expect(kv("disposed")).toBeUndefined();
  expect((await send("/echo/disable", {}, MACHINE)).status).toBe(403);
  const plugin = { enabled: false, status: "disabled", cliCommands: [] };
  const disabled = await send("/echo/disable", {});
  expect(disabled.body).toMatchObject({ ok: true, plugin });
  expect(kv("disposed")).toBe("true");
  const unavailable = [503, "plugin_unavailable"];
  expect(await rpc("echo/rpc/echo", { text: "x" })).toEqual(unavailable);
  expect((await request("/echo/http/none")).status).toBe(503);
  expect((await cli("echo", "say", "x"))[2]).toContain("not running");
  const enabled = await send("/echo/enable", {});
  expect(enabled.body).toMatchObject({ plugin: { status: "running" } });
  expect((await rpc("echo/rpc/echo", { text: "x" }))[0]).toBe(200);
});

it("reloads a changed external plugin and refuses rewritten migrations", async () => {
  const directory = join(scratch(), "echo");
  cpSync(FIXTURE, directory, { recursive: true });
  const { send, rpc, configFile } = await serverWithEcho(directory);
  const source = join(directory, "server.ts");
  const edit = (from: string, to: string): void =>
    writeFileSync(source, readFileSync(source, "utf8").replace(from, to));
  const reload = async (query = ""): Promise<InstalledPlugin[]> =>
    ((await send(`/reload${query}`, {})).body as Listing).plugins;
  await rpc("echo/rpc/echo", { text: "a" });
  edit('default: "hello"', 'default: "howdy"');
  edit('NOT NULL)"]', 'NOT NULL)", "CREATE TABLE extra (id INTEGER)"]');
  await reload("?id=echo");
  const echoed = { text: "howdy b", calls: 2 };
  expect(await rpc("echo/rpc/echo", { text: "b" })).toEqual([200, echoed]);
  edit("extra (id INTEGER)", "extra (id TEXT)");
  const statusMessage = expect.stringContaining("Migration 1 changed");
  const failed = { status: "error", statusMessage };
  expect((await reload()).at(-1)).toMatchObject(failed);
  writeFileSync(configFile, JSON.stringify({ plugins: [] }));
  expect((await reload()).map((plugin) => plugin.id)).not.toContain("echo");
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
  const useState = (value: number): number[] => [value];
  const clsx = (...names: string[]): string => names.join(" ");
  const sandbox = {
    module: { exports: {} as { default?: { setup(app: unknown): void } } },
    __bbPluginRuntime: {
      react: { default: { useState }, useState },
      "react/jsx-runtime": { jsx },
      clsx: { default: clsx, clsx },
      "@bb/plugin/app": { definePluginApp: (setup: unknown) => ({ setup }) },
    },
  };
  vm.runInNewContext(code, sandbox);
  const panels: { component(): unknown }[] = [];
  const slots = { navPanel: (panel: (typeof panels)[0]) => panels.push(panel) };
  sandbox.module.exports.default?.setup({ slots });
  const props = { className: "echo-panel flex", children: 2 };
  expect(panels[0]?.component()).toEqual({ type: "div", props });
});

it("round-trips thread-list preferences over rpc and its CLI", async () => {
  const { rpc, cli, socket } = await serverWithEcho();
  const client = await socket();
  const list = async (): Promise<unknown> =>
    (await rpc("thread-list/rpc/listPreferences", null))[1];
  const sorted = (chronologicalSort: string) => ({
    preferences: { chronologicalSort, collapsedSections: [] },
  });
  const change = { key: "chronologicalSort", value: "alpha" };
  const set = (input: object) => rpc("thread-list/rpc/setPreference", input);
  expect(await list()).toMatchObject(sorted("updated"));
  expect(await set(change)).toEqual([200, change]);
  const signal = { type: "plugin-signal", pluginId: "thread-list" };
  expect(await client.next()).toMatchObject({ ...signal, payload: change });
  expect(await set({ ...change, value: "sideways" })).toEqual([
    500,
    "handler_error",
  ]);
  expect(await list()).toMatchObject(sorted("alpha"));
  const read = await cli("thread-list", "prefs", "get", change.key, "--json");
  expect(read).toEqual([0, JSON.stringify(change), ""]);
});

it("answers the thread engine's queries from plugin registrations", async () => {
  const { ctx } = await createTestServer();
  const directory = scratch();
  const manifest = { name: "bb-plugin-probe", bb: { name: "Probe" } };
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  const idleTexts: (string | null)[] = [];
  let api: PluginServerApi | undefined;
  const server = (bb: PluginServerApi): void => {
    api = bb;
    bb.agents.registerTool({
      name: "Shout",
      description: "Shouts",
      instructions: "Use Shout sparingly.",
      parameters: z.object({ text: z.string() }),
      enabledFor: ({ providerId }) => providerId === "codex",
      execute: ({ text }) => text.toUpperCase(),
    });
    bb.agents.contributeInstructions(({ threadId }) => `Thread ${threadId}`);
    bb.providers.contributeEnv("codex", ({ hostId }) => [
      { name: "POOL_URL", value: { serverPath: `/pool/${hostId}` } },
    ]);
    bb.events.on("thread.idle", ({ lastAssistantText }) => {
      idleTexts.push(lastAssistantText);
    });
    bb.ui.registerMentionProvider({
      id: "note",
      label: "Notes",
      search: ({ query }) => [{ id: "n1", title: `Note ${query}` }],
      resolve: (id) => ({ context: `Body of ${id}` }),
    });
    const complete = async (prompt: string) => ` ${prompt.slice(0, 5)} `;
    bb.inference.register({ id: "tiny", displayName: "Tiny", complete });
    bb.status.needsConfiguration("Sign in first");
  };
  const plugins = new PluginHost({ ...ctx, builtins: [{ directory, server }] });
  plugins.deps = ctx.plugins.deps;
  await plugins.reload();
  const signal = new AbortController().signal;
  const thread = { threadId: "thr_1", projectId: "proj_1", hostId: "host_1" };
  const codex = { ...thread, providerId: "codex", signal };
  const status = {
    status: "needs-configuration",
    statusMessage: "Sign in first",
  };
  expect(plugins.list()).toMatchObject([{ id: "probe", ...status }]);
  const instructions = "Use Shout sparingly.\n\nThread thr_1";
  expect(await plugins.instructionsFor(codex)).toBe(instructions);
  expect(plugins.toolsFor({ ...codex, providerId: "claude-code" })).toEqual([]);
  const inputSchema = { type: "object", required: ["text"] };
  expect(plugins.toolsFor(codex)).toMatchObject([
    { name: "Shout", inputSchema },
  ]);
  const shouted = [{ type: "inputText", text: "HI" }];
  expect(await plugins.callTool("Shout", { text: "hi" }, codex)).toEqual({
    contentItems: shouted,
    success: true,
  });
  const refused = await plugins.callTool("Shout", {}, codex);
  expect(refused.success).toBe(false);
  const env = [{ name: "POOL_URL", value: { serverPath: "/pool/host_1" } }];
  expect(await plugins.contributedEnv("codex", codex)).toEqual(env);
  const idle = { thread: {} as ThreadResponse, lastAssistantText: "done" };
  plugins.emit("thread.idle", idle);
  expect(idleTexts).toEqual(["done"]);
  const query = { query: "x", projectId: null, threadId: null };
  const item = {
    itemId: "note:n1",
    title: "Note x",
    subtitle: null,
    icon: null,
  };
  const group = { pluginId: "probe", providerId: "note", label: "Notes" };
  const found = await plugins.searchMentions({ trigger: "@", ...query });
  expect(found).toEqual([{ ...group, items: [item] }]);
  expect(await plugins.searchMentions({ trigger: "#", ...query })).toEqual([]);
  expect(await plugins.generateTitle("Hello world", signal)).toBe("Hello");
  expect(await api?.threads.list()).toEqual([]);
});
