import { expect, it } from "vitest";
import { createThreadServer } from "./thread-harness.js";

it("files.url returns the address the server serves a file at", async () => {
  const server = await createThreadServer();
  const threadId = await server.spawn();
  const url = async (input: Record<string, unknown>) => {
    const response = await server.http<{ result: { url: string } }>(
      "POST",
      "/ops/files.url",
      { threadId, ...input },
    );
    expect(response.status).toBe(200);
    return response.body.result.url;
  };
  expect(await url({ path: "docs/a b.md" })).toMatch(
    /^\/api\/v1\/environments\/[^/]+\/files\/docs\/a%20b\.md$/,
  );
  expect(await url({ path: "/tmp/x.png" })).toBe(
    `/api/v1/threads/${threadId}/host-files/tmp/x.png`,
  );
  expect(await url({ path: "out.md", source: "thread-storage" })).toMatch(
    new RegExp(`^/api/v1/threads/${threadId}/host-files/.+/out\\.md$`),
  );
});
