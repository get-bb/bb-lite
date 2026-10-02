import { expect, it } from "vitest";
import { createTestServer } from "./helpers.js";

const editor = {
  id: "vscode",
  label: "VS Code",
  kind: "editor" as const,
  capabilities: {
    openDirectory: true,
    openFile: true,
    openFileAtLine: true,
    openFileAtColumn: true,
  },
};
const machine = { "x-bb-via-tunnel": "1", "x-bb-gate-auth": "machine" };

it("lists and launches the machine's open targets for the owner only", async () => {
  const { api, ctx, runner, url } = await createTestServer();
  runner.script.listOpenTargets = async () => ({ targets: [editor] });
  runner.script.openInTarget = async () => {};
  const param = { id: ctx.config.hostId };
  const host = api.hosts[":id"];

  const listed = await host["open-targets"].$get({ param });
  expect(await listed.json()).toEqual({ targets: [editor] });

  const file = { targetId: "vscode", path: "/repo/src/a.ts" };
  await host.open.$post({ param, json: { ...file, line: 12 } });
  const opened = await host.open.$post({ param, json: file });
  expect(await opened.json()).toEqual({ ok: true });
  const launches = runner.calls.filter(
    (call) => call.method === "openInTarget",
  );
  expect(launches.map((call) => call.args)).toEqual([
    [{ ...file, line: 12, column: null }],
    [{ ...file, line: null, column: null }],
  ]);

  const invalid = { param, json: { ...file, line: 0 } };
  expect((await host.open.$post(invalid)).status).toBe(400);
  const unknown = { param: { id: "host_missing" } };
  expect((await host["open-targets"].$get(unknown)).status).toBe(404);

  const base = `${url}/api/v1/hosts/${ctx.config.hostId}`;
  const headers = { ...machine, "content-type": "application/json" };
  const body = JSON.stringify(file);
  const asMachine = await Promise.all([
    fetch(`${base}/open-targets`, { headers }),
    fetch(`${base}/open`, { method: "POST", headers, body }),
  ]);
  expect(asMachine.map((response) => response.status)).toEqual([403, 403]);
  expect(
    runner.calls.filter((call) => call.method === "openInTarget"),
  ).toHaveLength(2);
});
