import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { API_VERSION, contract, op, type ApiLock } from "@bb/plugin";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { createRunnerPlugins } from "../../../packages/runner/src/index.js";
import {
  createTestServer,
  scratch,
} from "../../../apps/server/test/helpers.js";
import pluginDevRunner from "../runner.js";
import { changesFor, lockFor, lockHistory, upgradePlugin } from "../upgrade.js";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const probe = contract("probe", {
  ping: op({ input: z.object({}), output: z.string() }),
});

function machine() {
  const runners = createRunnerPlugins({ dataDir: scratch() });
  onTestFinished(() => runners.dispose());
  runners.load({ id: "plugin-dev", entry: pluginDevRunner });
  runners.load({
    id: "probe",
    entry: (bb) => bb.implement(probe.ping, () => "pong"),
  });
  return runners;
}

it("lists the runner parts loaded on a machine and what each implements", async () => {
  const runners = machine();
  expect(await runners.callOp("plugin-dev.machineParts", {})).toEqual(
    expect.arrayContaining([
      { id: "probe", tier: "product", implements: ["probe.ping"] },
      {
        id: "plugin-dev",
        tier: "product",
        implements: ["plugin-dev.machineParts"],
      },
    ]),
  );
});

it("inspects a machine from bb dev inspect --machine", async () => {
  const runners = machine();
  const server = await createTestServer();
  const hostId = server.ctx.config.hostId;
  server.runner.script.callOp = (sent) => runners.callOp(sent.name, sent.input);
  const cli = async (...argv: string[]) => {
    const sent = await server.send("/plugins/plugin-dev/cli", { argv });
    return (await sent.json()) as { exitCode: number; stdout: string };
  };
  const all = await cli("inspect", "--machine", hostId);
  expect(all.exitCode).toBe(0);
  expect(all.stdout).toContain(`machine ${hostId}`);
  expect(all.stdout).toContain("part probe  product\n  implements probe.ping");
  const some = await cli("inspect", "probe", "--machine", hostId);
  expect(some.stdout).toBe(
    `machine ${hostId}\npart probe  product\n  implements probe.ping`,
  );
  expect((await cli("inspect", "--machine", "nowhere")).exitCode).toBe(1);
});

const lock = (version: string, contracts: ApiLock["contracts"]): ApiLock => ({
  version,
  shapes: {},
  contracts,
});
const before = lock("1.0.0", {
  threads: {
    create: { type: "op", kind: "write", input: { type: "string" } },
    list: { type: "op", kind: "read" },
  },
  gone: { x: { type: "op", kind: "read" } },
});
const after = lock("1.1.0", {
  threads: {
    create: { type: "op", kind: "write", input: { type: "number" } },
    list: { type: "op", kind: "read" },
    archive: { type: "op", kind: "write" },
  },
});

it("reports only the changed members a plugin uses", () => {
  const changes = changesFor(["threads.create", "gone.x"], before, after);
  expect(changes.map(({ member, kind }) => [member, kind])).toEqual([
    ["threads.create", "breaking"],
    ["gone", "breaking"],
  ]);
  expect(changesFor(["threads.list"], before, after)).toEqual([]);
  expect(lockFor([after, before], "^1")?.version).toBe("1.0.0");
  expect(lockFor([after, before], "^1.1.0")?.version).toBe("1.1.0");
  expect(lockFor([after, before], "^2")).toBeNull();
});

function plugin(range: string) {
  const directory = join(scratch(), "hello");
  mkdirSync(directory, { recursive: true });
  const manifest = {
    name: "bb-plugin-hello",
    engines: { bb: range, node: ">=22" },
    bb: { name: "Hello", server: "./server.ts" },
  };
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  writeFileSync(
    join(directory, "server.ts"),
    "export default (bb) => bb.call(threads.create, {});\n",
  );
  return directory;
}

it("moves engines.bb to the target and reports what changed", async () => {
  const directory = plugin("^1.0.0");
  const report = await upgradePlugin(directory, "1.1.0", [before, after]);
  expect(report).toMatchObject({
    from: "1.0.0",
    to: "1.1.0",
    range: { before: "^1.0.0", after: "^1.1.0" },
    uses: ["threads.create"],
  });
  expect(report.changes.map(({ member }) => member)).toEqual([
    "threads.create",
  ]);
  const written = JSON.parse(
    readFileSync(join(directory, "package.json"), "utf8"),
  );
  expect(written.engines).toEqual({ bb: "^1.1.0", node: ">=22" });
  await expect(upgradePlugin(directory, "9.0.0", [before])).rejects.toThrow(
    "No locked plugin API 9.0.0",
  );
});

it("reads every locked API version from git history", async () => {
  const versions = (await lockHistory(REPO)).map(({ version }) => version);
  expect(versions[0]).toBe(API_VERSION);
  expect(versions).toContain("1.0.0");
});

it("upgrades from bb dev upgrade", async () => {
  const server = await createTestServer();
  const directory = plugin("^1.0.0");
  const sent = await server.send("/plugins/plugin-dev/cli", {
    argv: ["upgrade", directory],
  });
  const { exitCode, stdout } = (await sent.json()) as {
    exitCode: number;
    stdout: string;
  };
  expect(exitCode).toBe(0);
  expect(stdout.split("\n")[0]).toBe(
    `engines.bb ^1.0.0 -> ^${API_VERSION} (plugin API 1.0.0 -> ${API_VERSION})`,
  );
});
