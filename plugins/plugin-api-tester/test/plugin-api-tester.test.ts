import { expect, it } from "vitest";
import { createThreadServer } from "../../../apps/server/test/thread-harness.js";

it("answers its status operation through the CLI door", async () => {
  const server = await createThreadServer();
  const { body } = await server.http<{ exitCode: number; stdout: string }>(
    "POST",
    "/plugins/plugin-api-tester/cli",
    { argv: ["status"], cwd: "/" },
  );
  expect(body.exitCode).toBe(0);
  expect(JSON.parse(body.stdout)).toMatchObject({
    active: true,
    pluginId: "plugin-api-tester",
  });
});
