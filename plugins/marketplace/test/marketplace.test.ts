import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  commitAll,
  createTestServer,
  git as gitIn,
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
  const cli = async (argv: string[], cwd = "/") => {
    const sent = await server.send(`/plugins/marketplace/cli`, { argv, cwd });
    return JSON.parse(await sent.text()) as {
      exitCode: number;
      stdout: string;
    };
  };
  return { op, cli, server };
}

function release(repo: string, version: string) {
  const file = join(repo, "plugins", "greeter", "package.json");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as Body;
  writeFileSync(file, JSON.stringify({ ...manifest, version }));
  const git = (...args: string[]) => gitIn(repo, ...args);
  git("add", "-A");
  git("commit", "--quiet", "-m", version);
  git("tag", `greeter/v${version}`);
}

it("installs, updates and removes a plugin from a local catalog", async () => {
  const { op, cli, server } = await world();
  const repo = join(scratch(), "mono");
  mkdirSync(join(repo, "plugins"), { recursive: true });
  const made = await server.send(`/plugins/plugin-dev/cli`, {
    argv: ["new", "greeter", "--path", "plugins/greeter"],
    cwd: repo,
  });
  expect(await made.text()).toContain("Created");
  commitAll(repo);
  release(repo, "1.0.0");
  const git = (extra: Body) => ({
    git: { url: `file://${repo}`, subdir: "plugins/greeter", ...extra },
  });
  const catalog = join(scratch(), "catalog.json");
  const entry = (id: string, source: unknown, more: Body = {}) => ({
    id,
    displayName: id,
    description: `The ${id} plugin`,
    author: { name: "Test" },
    source,
    ...more,
  });
  writeFileSync(
    catalog,
    JSON.stringify({
      schemaVersion: 2,
      name: "local",
      plugins: [
        entry("greeter", git({ range: "^1", tagPrefix: "greeter/" }), {
          parts: ["server"],
        }),
        entry("future", git({ ref: "greeter/v1.0.0" }), {
          engines: { bb: ">=9" },
        }),
        entry("automations", { bundled: { plugin: "automations" } }),
        { id: "broken" },
      ],
    }),
  );
  await op("plugins.updateSettings", {
    pluginId: "marketplace",
    values: { catalogs: catalog },
  });

  const found = await op("marketplace.catalog", { query: "greeter" });
  expect(found.result).toMatchObject({
    errors: [],
    entries: [
      {
        id: "greeter",
        source: `git:file://${repo}`,
        subdir: "plugins/greeter",
        range: "^1",
        tagPrefix: "greeter/",
        parts: ["server"],
        installable: true,
        installed: null,
      },
    ],
  });
  const all = await cli(["search"]);
  expect(all.stdout).toContain("automations");
  expect(all.stdout).not.toContain("broken");

  const installed = await cli(["install", "greeter"]);
  expect(installed.stdout).toContain("Installed greeter 1.0.0");
  expect((await op("greeter.greet", { name: "Bo" })).result).toBe("Hello, Bo!");
  expect((await op("marketplace.updates")).result).toEqual([]);
  expect((await op("marketplace.install", { id: "greeter" })).status).toBe(409);

  release(repo, "1.1.0");
  release(repo, "2.0.0");
  expect((await op("marketplace.updates")).result).toEqual([
    { id: "greeter", version: "1.0.0", latest: "1.1.0" },
  ]);
  const updated = await op("marketplace.update", { id: "greeter" });
  expect(updated.result).toMatchObject({
    version: "1.1.0",
    ref: "greeter/v1.1.0",
    catalog,
  });
  const listed = await cli(["list"]);
  expect(listed.stdout).toContain("greeter 1.1.0");

  const future = await op("marketplace.install", { id: "future" });
  expect(future.body).toMatchObject({ code: "engine_mismatch" });
  const bundled = await op("marketplace.install", { id: "automations" });
  expect(bundled.status).toBe(400);

  expect((await cli(["remove", "greeter"])).exitCode).toBe(0);
  expect((await op("greeter.greet", { name: "Bo" })).status).toBe(501);
  expect((await op("marketplace.list")).result).toEqual([]);
});

it("reports a catalog it cannot read without failing the search", async () => {
  const { op } = await world();
  const missing = join(scratch(), "missing.json");
  await op("plugins.updateSettings", {
    pluginId: "marketplace",
    values: { catalogs: missing },
  });
  const found = await op("marketplace.catalog", {});
  expect(found.result).toMatchObject({
    entries: [],
    errors: [{ catalog: missing }],
  });
});
