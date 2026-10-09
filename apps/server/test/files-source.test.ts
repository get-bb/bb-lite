import { files, threads } from "@bb/plugin";
import { expect, it } from "vitest";
import { createThreadServer } from "./thread-harness.js";

it("files operations resolve workspace, thread storage and host sources", async () => {
  const server = await createThreadServer();
  const threadId = await server.spawn();
  const { kernel } = server.ctx;
  const seen: unknown[] = [];
  const record = (answer: unknown) => async (args: unknown) => {
    seen.push(args);
    return answer;
  };
  const content = { content: "hi", contentEncoding: "utf8", sha256: "s" };
  Object.assign(server.runner.script, {
    readFile: record(content),
    writeFile: record({ outcome: "written", sha256: "s" }),
    listPaths: record({ paths: [], truncated: false }),
    mutatePath: record({ ok: true }),
  });
  const workspace = await kernel.call(threads.workspace, { threadId });
  const storage = await kernel.call(threads.storageLocation, { threadId });
  expect(storage).not.toBeNull();
  const storagePath = storage?.path;
  const base = { threadId, path: "a.md" };
  await kernel.call(files.read, base);
  await kernel.call(files.read, { ...base, source: "thread-storage" });
  await kernel.call(files.read, { ...base, path: "/x.md", source: "host" });
  await kernel.call(files.write, {
    ...base,
    path: "/abs.md",
    content: "x",
    source: "thread-storage",
  });
  await kernel.call(files.list, { threadId, source: "thread-storage" });
  await kernel.call(files.mkdir, { ...base, source: "thread-storage" });
  await kernel.call(files.move, {
    threadId,
    from: "/a",
    to: "/b",
    source: "host",
  });
  expect(seen).toMatchObject([
    { path: "a.md", rootPath: workspace.path },
    { path: "a.md", rootPath: storagePath },
    { path: "/x.md", rootPath: undefined },
    { path: "/abs.md", rootPath: storagePath },
    { rootPath: storagePath, includeFiles: true },
    { op: "mkdir", path: "a.md", rootPath: storagePath },
    { op: "move", sourcePath: "/a", rootPath: undefined },
  ]);
  await expect(
    kernel.call(files.read, { ...base, source: "host" }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    kernel.call(files.list, { threadId, source: "host" }),
  ).rejects.toMatchObject({ code: "invalid_input" });
});
