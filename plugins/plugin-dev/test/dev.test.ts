import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  commitAll,
  createTestServer,
  scratch,
} from "../../../apps/server/test/helpers.js";

type Body = Record<string, unknown>;

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
