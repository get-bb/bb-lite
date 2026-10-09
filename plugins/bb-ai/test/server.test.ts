import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createTestServer } from "../../../apps/server/test/helpers.js";

it("answers bb ai on a real server without contacting getbb", async () => {
  const { url } = await createTestServer();
  const cli = async (...argv: string[]) => {
    const body = JSON.stringify({ argv, cwd: tmpdir() });
    const headers = { "content-type": "application/json" };
    const init = { method: "POST", headers, body };
    const response = await fetch(`${url}/api/v1/plugins/bb-ai/cli`, init);
    return (await response.json()) as { exitCode: number; stdout: string };
  };
  expect((await cli("status")).stdout).toContain("Not ready: Sign in");
  expect((await cli("off")).stdout).toContain("bb cloud is off");
  const view = JSON.parse((await cli("status", "--json")).stdout);
  expect(view).toMatchObject({ enabled: false, ready: false });
  expect((await cli("on")).stdout).toContain("not ready: Sign in");
});
