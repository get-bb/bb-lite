import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { pathFor } from "../port.js";
import {
  commitAll,
  createProject,
  createTestServer,
  scratch,
} from "../../../apps/server/test/helpers.js";

type Body = Record<string, unknown>;

const HERE = fileURLToPath(new URL(".", import.meta.url));

async function world() {
  const server = await createTestServer();
  const op = async (name: string, input: unknown = {}) => {
    const response = await server.send(`/ops/${name}`, input);
    const body = (await response.json()) as Body;
    return { status: response.status, body, result: body.result };
  };
  const cli = async (pluginId: string, argv: string[], cwd = "/") => {
    const sent = await server.send(`/plugins/${pluginId}/cli`, { argv, cwd });
    return JSON.parse(await sent.text()) as {
      exitCode: number;
      stdout: string;
      stderr: string;
    };
  };
  return { ...server, op, cli };
}

it("scaffolds, loads, reloads on change, validates and inspects a plugin", async () => {
  const { op, cli, ctx } = await world();
  const cwd = scratch();
  const made = await cli("plugin-dev", ["new", "hello-there"], cwd);
  const directory = join(cwd, "hello-there");
  expect(made.stdout).toContain(`Created ${directory}`);
  expect(existsSync(join(directory, ".bb", "tsconfig.json"))).toBe(true);
  const again = await cli("plugin-dev", ["new", "hello-there"], cwd);
  expect(again).toMatchObject({ exitCode: 1 });
  expect((await cli("plugin-dev", ["new", "Bad Name"], cwd)).exitCode).toBe(1);

  const watched = await cli("plugin-dev", ["watch", "hello-there"], cwd);
  expect(watched.stdout).toBe(
    "Loaded hello-there; it reloads when its files change",
  );
  const greeted = await op("hello-there.greet", { name: "Bo" });
  expect(greeted.result).toBe("Hello, Bo!");
  expect((await op("hello-there.greetings")).result).toBe(1);
  expect((await cli("hello-there", ["greet", "Cai"])).stdout).toBe(
    "Hello, Cai!",
  );
  const listed = ctx.plugins.list().find(({ id }) => id === "hello-there");
  expect(listed).toMatchObject({
    status: "running",
    app: { kind: "external" },
  });

  const file = join(directory, "server.ts");
  writeFileSync(file, readFileSync(file, "utf8").replace("Hello,", "Howdy,"));
  await vi.waitFor(
    async () => {
      const reloaded = await op("hello-there.greet", { name: "Bo" });
      expect(reloaded.result).toBe("Howdy, Bo!");
    },
    { timeout: 10_000, interval: 50 },
  );

  const checked = await cli("plugin-dev", ["validate", directory]);
  expect(checked.stdout).toContain("Hello There (hello-there)");
  expect(checked.stdout).toContain("parts: server, app");
  expect(checked.stdout).toContain("helloThere.greet  (server.ts)");
  expect(checked.stdout).toContain("No problems found.");
  writeFileSync(
    join(directory, "extra.ts"),
    'import { readFile } from "node:fs/promises";\n' +
      "export const load = (bb: { rpc: { register(): void } }) => {\n" +
      "  bb.rpc.register();\n  return readFile;\n};\n",
  );
  const report = (await op("plugin-dev.validate", { path: directory })).result;
  expect(report).toMatchObject({
    reaches: [{ what: "node built-ins: node:fs/promises", file: "extra.ts" }],
    legacy: [{ what: "bb.rpc", file: "extra.ts" }],
  });
  const broken = await op("plugin-dev.validate", { path: scratch() });
  expect(broken.result).toMatchObject({
    problems: ["There is no package.json."],
  });

  const inspected = await cli("plugin-dev", ["inspect", "hello-there."]);
  expect(inspected.stdout).toContain(
    "op hello-there.greet  write, hooks may rewrite",
  );
  expect(inspected.stdout).toContain(
    "implemented by hello-there; doors: app, cli, agent",
  );
  expect(inspected.stdout).toContain("live hello-there.greetings");
  const core = await cli("plugin-dev", ["inspect", "threads.send"]);
  expect(core.stdout).toContain("implemented by threads");

  await op("plugins.uninstall", { path: directory });
  expect((await op("hello-there.greet", { name: "Bo" })).status).toBe(501);
});

it("installs a plugin from a git repository", async () => {
  const { op, cli, ctx } = await world();
  const cwd = scratch();
  await cli("plugin-dev", ["new", "from-git"], cwd);
  const repo = join(cwd, "from-git");
  commitAll(repo);
  const installed = await op("plugin-dev.install", {
    source: `git:file://${repo}`,
  });
  const target = join(ctx.config.dataDir, "plugins-src", "from-git");
  expect(installed.result).toEqual({ id: "from-git", path: target });
  expect((await op("from-git.greet", { name: "Bo" })).result).toBe(
    "Hello, Bo!",
  );
  const twice = await op("plugin-dev.install", {
    source: `git:file://${repo}`,
  });
  expect(twice.status).toBe(500);
  const empty = await op("plugin-dev.install", { source: scratch() });
  expect(empty.body).toMatchObject({ code: "handler_error" });
});

it("forks every built-in plugin into a copy that runs in its place", async () => {
  const server = await createTestServer({}, "echo");
  const { ctx } = server;
  const op = async (name: string, input: unknown = {}) => {
    const response = await server.send(`/ops/${name}`, input);
    const body = (await response.json()) as Body;
    return { status: response.status, body, result: body.result };
  };
  const cwd = scratch();
  const builtins = ctx.plugins.list().map(({ id }) => id);
  expect(builtins).toContain("thread-list");
  const facts: Record<string, unknown> = {};
  for (const id of builtins) {
    const forked = await op("plugin-dev.fork", { id, cwd });
    expect([id, forked.status, forked.body.message]).toEqual([
      id,
      200,
      undefined,
    ]);
    const listed = ctx.plugins.list().find((plugin) => plugin.id === id);
    const failure = listed?.status === "error" ? listed.statusMessage : null;
    expect([id, failure]).toEqual([id, null]);
    const located = await op("plugins.describe", { id });
    expect(located.result).toMatchObject({
      builtin: false,
      directory: join(cwd, id),
    });
    if (listed?.app?.kind === "external") {
      const script = await server.request(`/plugins/${id}/app.js`);
      expect([id, script.status]).toEqual([id, 200]);
      facts[id] = listed.app.shared.filter((name) => name.startsWith("@bb/"));
    }
  }
  expect(facts["thread-list"]).toContain("@bb/client-core");
  expect(facts.tasks).toContain("@bb/shared-ui/button");
  for (const id of ["shell", "thread-view", "composer", "side-panel"]) {
    expect([id, facts[id]]).toEqual([
      id,
      expect.arrayContaining(["@bb/app-kit/plugins/parts"]),
    ]);
  }
  expect(facts.settings).toContain("@bb/app-kit/plugins/slots");
  expect(ctx.plugins.utilities).toBeNull();
  const parts = await ctx.plugins.runnerParts();
  expect(parts.map(({ id }) => id).sort()).toEqual([
    "concurrency-limit",
    "provider-claude-code",
    "provider-codex",
    "provider-echo",
  ]);
  const providers = await ctx.runners.get(ctx.config.hostId).listProviders();
  expect(providers.map(({ providerId }) => providerId)).toContain("echo");
  const again = await op("plugin-dev.fork", { id: "tasks", cwd });
  expect(again.status).toBe(500);
  const core = ctx.plugins.list().filter((plugin) => plugin.core);
  expect(core.map(({ id }) => id)).toContain("threads");
  const directory = join(ctx.config.dataDir, "repo");
  mkdirSync(directory);
  const project = await createProject(server, "echo", directory);
  const input = [{ type: "text", text: "from a forked engine" }];
  const environment = { type: "project-default" };
  const request = { projectId: project.id, origin: "app", providerId: "echo" };
  const spawned = await server.send("/threads", {
    ...request,
    input,
    environment,
    startedOnBehalfOf: null,
  });
  const { id: threadId } = (await spawned.json()) as { id: string };
  await vi.waitFor(async () => {
    const reply = { output: "Response to: from a forked engine" };
    expect(await server.read(`/threads/${threadId}/output`)).toEqual(reply);
  });

  const file = join(cwd, "custom-instructions", "server.ts");
  const source = readFileSync(file, "utf8");
  writeFileSync(file, source.replace("return [{", "return [{ forked: true,"));
  await op("plugins.reload", { id: "custom-instructions" });
  await server.send("/plugins/custom-instructions/settings", {
    values: { instructions: "Use pnpm" },
  });
  await fetch(`${server.url}/api/v1/plugins/custom-instructions/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { instructions: "Use pnpm" } }),
  });
  const scope = { threadId: "t", projectId: "p", hostId: null };
  const sections = await op("sessions.instructions", {
    ...scope,
    providerId: "codex",
  });
  expect(sections.result).toContainEqual({
    source: "custom-instructions",
    text: "Use pnpm",
  });
  const tsc = fileURLToPath(
    new URL("../../../node_modules/.bin/tsc", import.meta.url),
  );
  for (const id of ["threads", "composer"]) {
    const checked = promisify(execFile)(tsc, ["--noEmit", "-p", "."], {
      cwd: join(cwd, id),
    });
    const problems = await checked.then(
      () => "",
      (error: { stdout?: string }) => error.stdout ?? String(error),
    );
    expect([id, problems.slice(0, 600)]).toEqual([id, ""]);
  }
  await op("plugins.uninstall", { path: join(cwd, "tasks") });
  const restored = await op("plugins.describe", { id: "tasks" });
  expect(restored.result).toMatchObject({ builtin: true });
}, 120_000);

it("copies a plugin under a new id that runs beside the original", async () => {
  const server = await createTestServer({}, "echo");
  const { ctx } = server;
  const cwd = scratch();
  const fork = async (input: object) => {
    const response = await server.send("/ops/plugin-dev.fork", {
      cwd,
      ...input,
    });
    return (await response.json()) as Body;
  };
  const copied = await fork({ id: "tasks", as: "my-tasks" });
  expect(copied.result).toEqual({
    id: "my-tasks",
    path: join(cwd, "my-tasks"),
    beside: "tasks",
  });
  const status = (id: string) =>
    ctx.plugins.list().find((plugin) => plugin.id === id)?.status;
  expect([status("tasks"), status("my-tasks")]).toEqual(["running", "running"]);
  const manifest = readFileSync(join(cwd, "my-tasks", "package.json"), "utf8");
  expect(JSON.parse(manifest)).toMatchObject({
    name: "bb-plugin-my-tasks",
    bb: { forkOf: "tasks" },
  });
  const owners = new Map(
    ctx.kernel.inspect().ops.map(({ name, owner }) => [name, owner]),
  );
  const mine = [...owners].filter(([, owner]) => owner === "my-tasks");
  expect(mine.length).toBeGreaterThan(0);
  expect(mine.every(([name]) => name.startsWith("my-tasks."))).toBe(true);
  expect(ctx.plugins.cliOf("my-tasks")?.name).toBe("my-tasks");
  expect(ctx.plugins.cliOf("tasks")?.name).toBe("tasks");

  await fork({ id: "ask-user-question", as: "my-questions" });
  expect(status("my-questions")).toBe("running");
  const agentTools = ctx.kernel.ops().flatMap(({ op, owner }) => {
    const { agent } = op.doors;
    return agent === undefined ? [] : [`${owner}:${agent.name}`];
  });
  expect(agentTools).toContain("ask-user-question:AskUserQuestion");
  expect(agentTools).toContain("my-questions:MyQuestionsAskUserQuestion");

  const taken = await fork({ id: "audit", as: "tasks" });
  expect(taken.message).toContain("already installed");
  const invalid = await fork({ id: "audit", as: "Not Valid" });
  expect(invalid.message).toContain("lower-case");
}, 120_000);

it("reports what a plugin written for the original bb uses and what each call is now", async () => {
  const { cli } = await world();
  const directory = join(scratch(), "old-plugin");
  mkdirSync(directory);
  const themes = [{ id: "dusk", name: "Dusk", css: "./dusk.css" }];
  const bb = { name: "Old", server: "./server.ts", app: "./app.tsx", themes };
  const manifest = { name: "bb-plugin-old", engines: { bb: ">=0.1" }, bb };
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  const server = [
    'import type { BbPluginApi } from "@get-bb/plugin-sdk";',
    "export default async function plugin(bb: BbPluginApi) {",
    '  bb.rpc.register("ping", async () => "pong");',
    '  await bb.sdk.files.mkdir({ rootPath: "/tmp", path: "a" });',
    '  await bb.sdk.environments.pullRequest({ environmentId: "env" });',
    '  await bb.sdk.threads.paneAction({ threadId: "t", action: "x" });',
    "}",
  ];
  writeFileSync(join(directory, "server.ts"), server.join("\n"));
  const app = [
    'import { definePluginApp, useComposer } from "@get-bb/plugin-sdk/app";',
    "export default definePluginApp((bb) => {",
    '  bb.slots.messageAction({ id: "copy", label: "Copy", run() {} });',
    "});",
    "export function Lock() {",
    "  const composer = useComposer();",
    '  composer?.setTextEffect({ className: "dim" });',
    "  return null;",
    "}",
  ];
  writeFileSync(join(directory, "app.tsx"), app.join("\n"));
  const { stdout } = await cli("plugin-dev", ["port", directory]);
  const section = (heading: string) => {
    const from = stdout.indexOf(heading);
    const rest = stdout.slice(from + heading.length);
    const next = rest.search(/\n\S/u);
    return from < 0 ? "" : rest.slice(0, next < 0 ? undefined : next);
  };
  const missing = section("No counterpart");
  expect(missing).toContain("server.sdk.threads.paneAction");
  const feature = section("Needs a feature this bb does not have");
  expect(feature).toContain("server.sdk.environments.pullRequest");
  expect(section("Renamed")).toContain("bb.call(files.mkdir");
  expect(section("Renamed")).toContain("threadView.messageAction");
  expect(section("Works differently")).toContain("server.rpc.register");
  const unchanged = section("Unchanged");
  expect(unchanged).toContain("manifest.themes");
  expect(unchanged).toContain("app.useComposer.setTextEffect");
});

it("has a path for all but a known few of the original calls plugins use", async () => {
  const text = readFileSync(join(HERE, "..", "old-sdk.json"), "utf8");
  const used = JSON.parse(text) as { id: string }[];
  const none = used
    .filter(({ id }) => pathFor(id).status === "none")
    .map(({ id }) => id);
  expect(used.length).toBe(579);
  expect(none).toEqual(["server.sdk.threads.paneAction"]);
});
