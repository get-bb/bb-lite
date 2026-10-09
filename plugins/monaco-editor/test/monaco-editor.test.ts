import { expect, it } from "vitest";
import { RunnerError } from "@bb/runner";
import { createThreadServer } from "../../../apps/server/test/thread-harness.js";

interface WriteInput {
  path: string;
  rootPath?: string;
  content: string;
  expectedSha256?: string | null;
}

async function editorServer(disk: Record<string, string>) {
  const server = await createThreadServer();
  const shaOf = (content: string) => `sha-${content.length}-${content}`;
  const absolute = (input: { path: string; rootPath?: string }) =>
    input.path.startsWith("/") ? input.path : `${input.rootPath}/${input.path}`;
  Object.assign(server.runner.script, {
    readFile: async (input: { path: string; rootPath?: string }) => {
      const path = absolute(input);
      const content = disk[path];
      if (content === undefined) {
        throw new RunnerError("path_not_found", "missing");
      }
      const sizeBytes = content.length;
      const sha256 = shaOf(content);
      return { path, content, contentEncoding: "utf8", sizeBytes, sha256 };
    },
    writeFile: async (input: WriteInput) => {
      const path = absolute(input);
      const current = disk[path];
      const expected = input.expectedSha256;
      const currentSha = current === undefined ? null : shaOf(current);
      if (expected !== undefined && expected !== currentSha) {
        return { outcome: "conflict", currentSha256: currentSha };
      }
      disk[path] = input.content;
      return { outcome: "written", path, sha256: shaOf(input.content) };
    },
  });
  const threadId = await server.spawn();
  const call = (name: string, input: Record<string, unknown>) =>
    server.http<{ result: Record<string, unknown> }>(
      "POST",
      `/ops/monaco-editor.${name}`,
      { threadId, ...input },
    );
  return { call, disk };
}

it("opens a workspace file and saves it, stopping on a changed file", async () => {
  const { call, disk } = await editorServer({ "/repo/src/a.ts": "let a = 1" });
  const opened = await call("read", { path: "src/a.ts" });
  expect(opened.body.result).toEqual({
    kind: "text",
    content: "let a = 1",
    sha256: "sha-9-let a = 1",
  });
  const saved = await call("write", {
    path: "src/a.ts",
    content: "let a = 2",
    expectedSha256: opened.body.result.sha256,
  });
  expect(saved.body.result).toEqual({
    outcome: "written",
    sha256: "sha-9-let a = 2",
  });
  expect(disk["/repo/src/a.ts"]).toBe("let a = 2");
  const stale = await call("write", {
    path: "src/a.ts",
    content: "let a = 3",
    expectedSha256: opened.body.result.sha256,
  });
  expect(stale.body.result).toEqual({ outcome: "conflict" });
  expect(disk["/repo/src/a.ts"]).toBe("let a = 2");
  const overwritten = await call("write", {
    path: "src/a.ts",
    content: "let a = 3",
  });
  expect(overwritten.body.result).toMatchObject({ outcome: "written" });
  expect(disk["/repo/src/a.ts"]).toBe("let a = 3");
});

it("refuses missing, binary and oversized files", async () => {
  const { call } = await editorServer({
    "/repo/image.ts": "a\u0000b",
    "/repo/huge.txt": "x".repeat(8 * 1024 * 1024 + 1),
  });
  const reasons = await Promise.all(
    ["missing.ts", "image.ts", "huge.txt"].map(async (path) => {
      const response = await call("read", { path });
      return response.body.result.reason;
    }),
  );
  expect(reasons).toEqual([
    "This file is missing",
    "This file is not text",
    "This file is too large to edit (8 MB)",
  ]);
});
