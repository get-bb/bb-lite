import { expect, it } from "vitest";
import { createTestServer } from "../../../apps/server/test/helpers.js";
import { memberFacts, mergeContracts } from "../reference.js";

type CliResult = { exitCode: number; stdout: string };

async function cli(argv: string[]) {
  const server = await createTestServer({}, "fake", ":memory:", [
    "plugin-api-docs",
    "plugin-api-tester",
  ]);
  const response = await server.send("/plugins/plugin-api-docs/cli", {
    argv,
  });
  return (await response.json()) as CliResult;
}

it("prints a core operation with its door, owner and shapes", async () => {
  const { exitCode, stdout } = await cli(["threads.get"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("### threads.get (op)");
  expect(stdout).toContain("- Side: server");
  expect(stdout).toContain("- HTTP: GET /api/v1/threads/:threadId");
  expect(stdout).toContain("- Kind: read");
  expect(stdout).toMatch(/- Implemented by: \S+/u);
  expect(stdout).toContain('"threadId"');
});

it("prints the shapes of an operation another plugin declares", async () => {
  const { exitCode, stdout } = await cli(["plugin-api-tester.status"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("- Declared by: plugin-api-tester");
  expect(stdout).toContain("- CLI: bb api-tester status");
  expect(stdout).toContain("- Implemented by: plugin-api-tester");
  expect(stdout).toContain('"active"');
});

it("lists server and app contracts and builds CLI usage", async () => {
  const listed = await cli([]);
  expect(listed.stdout).toMatch(/^Plugin API \d/u);
  expect(listed.stdout).toContain("- plugin-api-tester (1)");
  expect(listed.stdout).toMatch(/- shell \(\d+, app only\)/u);
  const slot = await cli(["shell.navPanel"]);
  expect(slot.stdout).toContain("- Side: app");
  expect(slot.stdout).not.toContain("Filled by");
  const own = await cli(["plugin-api.get"]);
  expect(own.stdout).toContain(
    "- CLI: bb plugin-api [<name>] [--plugin <plugin>]",
  );
});

it("prints what one plugin declares, implements and fills", async () => {
  const { stdout } = await cli(["--plugin", "plugin-api-docs"]);
  expect(stdout).toContain("## Plugin plugin-api-docs");
  expect(stdout).toContain("- Declares: plugin-api");
  expect(stdout).toContain("- Implements: plugin-api.get");
  expect(stdout).toContain("- Fills: sessions.mention");
  const missing = await cli(["--plugin", "nope"]);
  expect(missing.stdout).toContain('No plugin "nope" is loaded.');
});

it("merges a contract both kernels know and shows who fills it on each side", () => {
  const slot = (filledBy: string[]) => ({
    id: "composer",
    plugin: "core",
    members: { action: { type: "slot", pick: "many", key: null, filledBy } },
  });
  const [merged] = mergeContracts([
    { side: "server", described: { api: "1", contracts: [slot(["a"])] } },
    { side: "app", described: { api: "1", contracts: [slot(["b", "c"])] } },
  ]);
  expect(merged?.sides).toEqual(["server", "app"]);
  const member = merged?.members[0];
  if (member === undefined) throw new Error("no member");
  expect(memberFacts(member, "core")).toEqual(
    expect.arrayContaining([
      { label: "Side", value: "server and app" },
      { label: "Filled by (server)", value: "a" },
      { label: "Filled by (app)", value: "b, c" },
    ]),
  );
});
