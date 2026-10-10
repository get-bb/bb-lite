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
  const listed: { rootPath: string; excludeNames: string[] }[] = [];
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
    listPaths: async (input: { rootPath: string; excludeNames: string[] }) => {
      listed.push(input);
      return {
        paths: [
          {
            kind: "directory",
            path: "src",
            name: "src",
            score: 0,
            positions: [],
          },
          {
            kind: "file",
            path: "src/a.ts",
            name: "a.ts",
            score: 0,
            positions: [],
          },
        ],
        truncated: false,
      };
    },
  });
  const threadId = await server.spawn();
  const call = (name: string, input: Record<string, unknown>) =>
    server.http<{ result: Record<string, unknown> }>(
      "POST",
      `/ops/monaco-editor.${name}`,
      { threadId, ...input },
    );
  return { call, disk, listed, threadId };
}

it("opens a workspace file and saves it, stopping on a changed file", async () => {
  const { call, disk } = await editorServer({ "/repo/src/a.ts": "let a = 1" });
  const opened = await call("read", { path: "src/a.ts" });
  expect(opened.body.result).toEqual({
    kind: "text",
    content: "let a = 1",
    sha256: "sha-9-let a = 1",
    absolutePath: "/repo/src/a.ts",
    relativePath: "src/a.ts",
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

it("lists the workspace as a tree for the file panel", async () => {
  const { call, listed } = await editorServer({});
  const tree = await call("tree", { path: "src/a.ts" });
  expect(tree.body.result).toEqual({
    root: "/repo",
    entries: [
      { path: "src", kind: "directory" },
      { path: "src/a.ts", kind: "file" },
    ],
    truncated: false,
  });
  expect(listed[0]).toMatchObject({
    rootPath: "/repo",
    excludeNames: [".git", "node_modules"],
  });
});

it("opens host and thread-storage files where they live", async () => {
  const { call, disk, threadId } = await editorServer({ "/etc/hosts": "h" });
  const host = await call("read", { path: "/etc/hosts", source: "host" });
  expect(host.body.result).toMatchObject({
    kind: "text",
    absolutePath: "/etc/hosts",
    relativePath: "hosts",
  });
  const saved = await call("write", {
    path: "notes.md",
    source: "thread-storage",
    content: "kept",
    expectedSha256: null,
  });
  expect(saved.body.result).toMatchObject({ outcome: "written" });
  const [stored] = Object.keys(disk).filter((path) =>
    path.endsWith(`${threadId}/notes.md`),
  );
  expect(disk[stored ?? ""]).toBe("kept");
  const read = await call("read", {
    path: "notes.md",
    source: "thread-storage",
  });
  expect(read.body.result).toMatchObject({
    content: "kept",
    absolutePath: stored,
    relativePath: "notes.md",
  });
});

it("opens a project checkout file with no thread", async () => {
  const { call } = await editorServer({ "/repo/src/b.ts": "let b = 2" });
  const opened = await call("read", {
    threadId: null,
    projectId: "proj_1",
    path: "src/b.ts",
  });
  expect(opened.body.result).toMatchObject({
    kind: "text",
    content: "let b = 2",
    absolutePath: "/repo/src/b.ts",
    relativePath: "src/b.ts",
  });
  const missing = await call("read", { threadId: null, path: "src/b.ts" });
  expect(missing.status).toBe(400);
});
