import { cpSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  createTestServer,
  scratch,
} from "../../../apps/server/test/helpers.js";
import { portReport } from "../port.js";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

function copy(name: string): string {
  const directory = join(scratch(), name);
  cpSync(join(FIXTURES, name), directory, { recursive: true });
  return directory;
}

async function post(
  server: Awaited<ReturnType<typeof createTestServer>>,
  path: string,
  body: unknown,
) {
  const response = await server.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as never };
}

it("refuses an unported plugin with a pointer to bb dev port", async () => {
  const server = await createTestServer();
  const path = copy("nap-guard-original");
  const { status, body } = await post(server, "/ops/plugins.install", {
    path,
  });
  expect(status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(body)).toContain("bb dev port");
});

it("loads the plugin once ported by following the port report", async () => {
  const report = await portReport(join(FIXTURES, "nap-guard-original"));
  const paths = new Map(report.map(({ id, now }) => [id, now]));
  expect(paths.get("server.sdk.hosts.list")).toBe("bb.call(machines.list)");
  expect(paths.get("app.slots.settingsSection")).toContain("settings.section");
  const server = await createTestServer();
  const path = copy("nap-guard-ported");
  const installed = await post(server, "/ops/plugins.install", { path });
  expect(installed.status).toBe(200);
  const list = await post(server, "/ops/plugins.list", {});
  type Listed = { result: { plugins: { id: string; status: string }[] } };
  const { plugins } = (list.body as Listed).result;
  expect(plugins.find(({ id }) => id === "nap-guard")?.status).toBe("running");
  const updated = await post(server, "/ops/nap-guard.updateConfiguration", {
    enabled: true,
  });
  expect(updated.body).toMatchObject({ result: { enabled: true } });
  const cli = await post(server, "/plugins/nap-guard/cli", {
    argv: ["status"],
    cwd: "/work",
  });
  expect(cli.body).toMatchObject({ exitCode: 0, stdout: "Enabled, 1 hosts" });
});
