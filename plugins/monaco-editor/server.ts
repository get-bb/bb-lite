import { posix } from "node:path";
import { fail, threads, type PluginServerApi } from "@bb/plugin";
import { machineFiles, RunnerError } from "@bb/runner";
import {
  MAX_EDITABLE_BYTES,
  MAX_TREE_ENTRIES,
  monacoEditor,
} from "./contract.js";

interface Location {
  threadId: string | null;
  source: "workspace" | "thread-storage" | "host";
  path: string;
}
interface Target {
  hostId: string;
  root: string;
  path: string;
}

const TREE_EXCLUDED = [".git", "node_modules"];

const unsupported = (reason: string) => ({
  kind: "unsupported" as const,
  reason,
});

export default function monacoEditorServer(bb: PluginServerApi): void {
  const resolveTarget = async ({
    threadId,
    source,
    path,
  }: Location): Promise<Target> => {
    if (source === "workspace") {
      if (threadId === null) {
        fail("invalid", "A workspace file needs a thread");
      }
      const workspace = await bb.call(threads.workspace, { threadId });
      const root = workspace.path;
      const absolute = posix.isAbsolute(path) ? path : posix.join(root, path);
      return { hostId: workspace.hostId, root, path: absolute };
    }
    if (source === "thread-storage") {
      if (threadId === null) fail("invalid", "Thread storage needs a thread");
      const storage = await bb.call(threads.storageLocation, { threadId });
      if (storage === null) fail("not_found", "This thread has no storage");
      const absolute = posix.isAbsolute(path)
        ? path
        : posix.join(storage.path, path);
      return { hostId: storage.hostId, root: storage.path, path: absolute };
    }
    if (!posix.isAbsolute(path)) fail("invalid", "A host path is absolute");
    if (threadId === null) {
      const root = posix.dirname(path);
      return { hostId: bb.server.hostId, root, path };
    }
    const storage = await bb.call(threads.storageLocation, { threadId });
    if (storage !== null && path.startsWith(`${storage.path}/`)) {
      return { hostId: storage.hostId, root: storage.path, path };
    }
    const workspace = await bb.call(threads.workspace, { threadId });
    return { hostId: workspace.hostId, root: posix.dirname(path), path };
  };

  bb.implement(monacoEditor.read, async (input) => {
    const target = await resolveTarget(input);
    const file = await bb.runners
      .call(target.hostId, machineFiles.read, { path: target.path })
      .catch((error: unknown) => {
        if (error instanceof RunnerError && error.code === "path_not_found") {
          return null;
        }
        throw error;
      });
    if (file === null || !("content" in file)) {
      return unsupported("This file is missing");
    }
    if (file.sizeBytes > MAX_EDITABLE_BYTES) {
      const megabytes = Math.round(file.sizeBytes / 1024 / 1024);
      return unsupported(`This file is too large to edit (${megabytes} MB)`);
    }
    const content =
      file.contentEncoding === "base64"
        ? Buffer.from(file.content, "base64").toString("utf8")
        : file.content;
    if (content.includes("\u0000")) {
      return unsupported("This file is not text");
    }
    const relativePath =
      posix.relative(target.root, target.path) || posix.basename(target.path);
    return {
      kind: "text" as const,
      content,
      sha256: file.sha256,
      absolutePath: target.path,
      relativePath,
    };
  });

  bb.implement(
    monacoEditor.write,
    async ({ content, expectedSha256, ...at }) => {
      const target = await resolveTarget(at);
      const result = await bb.runners.call(target.hostId, machineFiles.write, {
        path: target.path,
        content,
        contentEncoding: "utf8",
        createParents: true,
        ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
      });
      if (result.outcome === "conflict")
        return { outcome: "conflict" as const };
      return { outcome: "written" as const, sha256: result.sha256 };
    },
  );

  bb.implement(monacoEditor.tree, async (input) => {
    const { hostId, root } = await resolveTarget(input);
    const listed = await bb.runners.call(hostId, machineFiles.list, {
      rootPath: root,
      limit: MAX_TREE_ENTRIES,
      includeFiles: true,
      includeDirectories: true,
      includeHidden: true,
      excludeNames: TREE_EXCLUDED,
    });
    const entries = listed.paths.map(({ path, kind }) => ({ path, kind }));
    return { root, entries, truncated: listed.truncated };
  });
}
