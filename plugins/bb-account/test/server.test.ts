import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createTestServer } from "../../../apps/server/test/helpers.js";

it("answers bb account status on a real server", async () => {
  const { url } = await createTestServer();
  const cli = async (...argv: string[]) => {
    const body = JSON.stringify({ argv, cwd: tmpdir() });
    const headers = { "content-type": "application/json" };
    const init = { method: "POST", headers, body };
    const response = await fetch(`${url}/api/v1/plugins/bb-account/cli`, init);
    return (await response.json()) as { exitCode: number; stdout: string };
  };
  const text = await cli("status");
  expect(text.stdout).toContain("Not signed in");
  const json = await cli("status", "--json");
  expect(JSON.parse(json.stdout)).toMatchObject({
    signedIn: false,
    hosted: false,
  });
});
