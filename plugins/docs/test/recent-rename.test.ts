import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestServer } from "../../../apps/server/test/helpers.js";

it("points recent documents at the new path after rename to title", async () => {
  const server = await createTestServer({}, "workspace");
  const op = async (name: string, input: Record<string, unknown>) => {
    const response = await fetch(`${server.url}/api/v1/ops/docs.${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = (await response.json()) as { result: unknown };
    expect(response.ok).toBe(true);
    return body.result;
  };
  const root = mkdtempSync(join(tmpdir(), "docs-vault-"));
  await op("createVault", { name: "Team", absoluteRoot: root });
  writeFileSync(join(root, "untitled.md"), "# Launch Plan\n");
  writeFileSync(join(root, "other.md"), "other\n");
  const team = { vault: "team" };
  for (const path of ["other.md", "untitled.md"])
    await op("visit", { threadId: "thr_1", ...team, path });
  await op("visit", { threadId: "thr_2", ...team, path: "other.md" });
  await op("renameToTitle", { ...team, path: "untitled.md" });
  expect(await op("recent", { threadId: "thr_1" })).toEqual([
    { vault: "team", path: "Launch Plan.md" },
    { vault: "team", path: "other.md" },
  ]);
  expect(await op("recent", { threadId: "thr_2" })).toEqual([
    { vault: "team", path: "other.md" },
  ]);
});
