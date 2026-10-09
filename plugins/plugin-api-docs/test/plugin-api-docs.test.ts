import { expect, it } from "vitest";
import { createTestServer } from "../../../apps/server/test/helpers.js";

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
  expect(stdout).toContain("- Declared by: core");
  expect(stdout).toContain("- HTTP: GET /api/v1/threads/:threadId");
  expect(stdout).toContain("- Kind: read");
  expect(stdout).toMatch(/- Implemented by: \S+/u);
  expect(stdout).toContain('"threadId"');
});

it("prints an operation another loaded plugin declares", async () => {
  const { exitCode, stdout } = await cli(["plugin-api-tester.status"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("### plugin-api-tester.status (op)");
  expect(stdout).toContain("- Doors: app, cli");
  expect(stdout).toContain("- Implemented by: plugin-api-tester");
  expect(stdout).toContain("Shapes are not published");
});

it("lists contracts with the API version and finds members by word", async () => {
  const listed = await cli([]);
  expect(listed.stdout).toMatch(/^Plugin API \d/u);
  expect(listed.stdout).toContain("- plugin-api-tester (1)");
  const found = await cli(["searchMentions"]);
  expect(found.stdout).toContain("### sessions.searchMentions (op)");
  const own = await cli(["plugin-api.get"]);
  expect(own.stdout).toContain("- CLI: bb plugin-api [<name>]");
});
