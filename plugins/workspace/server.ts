import {
  FILE_PAYLOAD_MAX_BYTES,
  machineFiles,
  type FileLocation,
} from "@bb/runner";
import { createHash } from "node:crypto";
import { isAbsolute, posix, resolve } from "node:path";
import {
  files,
  OpError,
  threads,
  type FileSource,
  type PluginServerApi,
} from "@bb/plugin";
import { RunnerError } from "@bb/runner";
import { implementMachineFiles, registerFileRoutes } from "./routes.js";
import { startWorkspaceWatch } from "./watch.js";

export const FILE_READ_MAX_BYTES = 16 * 1024 * 1024;

const served = (path: string) =>
  path.replace(/^\/+/u, "").split("/").map(encodeURIComponent).join("/");

export default function workspace(bb: PluginServerApi): void {
  const { runners } = bb;
  const workspaceOf = (threadId: string) =>
    bb.call(threads.workspace, { threadId });
  const storageOf = async (threadId: string) => {
    const storage = await bb.call(threads.storageLocation, { threadId });
    if (storage === null) {
      throw new OpError("not_found", "This thread has no storage directory.");
    }
    return storage;
  };
  const based = async (
    threadId: string,
    paths: string[],
    source: FileSource = "workspace",
  ) => {
    if (source === "thread-storage") return storageOf(threadId);
    const { hostId, path } = await workspaceOf(threadId);
    if (source === "workspace") return { hostId, path };
    if (paths.length > 0 && paths.every((path) => isAbsolute(path))) {
      return { hostId, path: null };
    }
    throw new OpError("invalid_input", "Host file paths must be absolute.");
  };
  const located = async (
    threadId: string,
    path: string,
    source?: FileSource,
  ) => {
    const base = await based(threadId, [path], source);
    const free = isAbsolute(path) && source !== "thread-storage";
    const rootPath = free ? undefined : (base.path ?? undefined);
    return { runner: runners.get(base.hostId), rootPath };
  };
  const readChunked = async (
    runner: ReturnType<typeof runners.get>,
    location: FileLocation,
  ) => {
    const chunk = (offset: number, length: number, revision: string | null) =>
      runner.call(machineFiles.readChunk, {
        ...location,
        offset,
        length,
        revision,
      });
    const { sizeBytes, revision } = await chunk(0, 0, null);
    if (sizeBytes > FILE_READ_MAX_BYTES) {
      const limit = `${sizeBytes} bytes; max ${FILE_READ_MAX_BYTES}`;
      const message = `${location.path} is too large to read (${limit}).`;
      throw new OpError("invalid_input", message);
    }
    const parts: Buffer[] = [];
    for (let offset = 0; offset < sizeBytes;) {
      const length = Math.min(FILE_PAYLOAD_MAX_BYTES, sizeBytes - offset);
      const { dataBase64 } = await chunk(offset, length, revision);
      const part = Buffer.from(dataBase64, "base64");
      if (part.length !== length) {
        throw new OpError("conflict", "File changed during read");
      }
      parts.push(part);
      offset += length;
    }
    return Buffer.concat(parts);
  };
  bb.http.api((app) => registerFileRoutes(app, bb));
  implementMachineFiles(bb);
  bb.implement(files.read, async (args) => {
    const { threadId, path, encoding = "utf8", source } = args;
    const { runner, rootPath } = await located(threadId, path, source);
    const location = { path, rootPath };
    const failed = (error: unknown) =>
      error instanceof RunnerError ? error.code : null;
    try {
      const file = await runner.call(machineFiles.read, location);
      if (!("content" in file)) return null;
      const bytes = Buffer.from(file.content, file.contentEncoding);
      return { content: bytes.toString(encoding), sha256: file.sha256 };
    } catch (error) {
      if (failed(error) === "path_not_found") return null;
      if (failed(error) !== "file_too_large") throw error;
    }
    const bytes = await readChunked(runner, location);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { content: bytes.toString(encoding), sha256 };
  });
  bb.implement(files.url, async ({ threadId, path, source }) => {
    const kind = source ?? (isAbsolute(path) ? "host" : "workspace");
    if (kind === "workspace") {
      const { id } = await workspaceOf(threadId);
      return {
        url: `/api/v1/environments/${encodeURIComponent(id)}/files/${served(path)}`,
      };
    }
    let absolute = path;
    if (kind === "thread-storage") {
      absolute = posix.join((await storageOf(threadId)).path, path);
    }
    return {
      url: `/api/v1/threads/${encodeURIComponent(threadId)}/host-files/${served(absolute)}`,
    };
  });
  bb.implement(files.write, async (args) => {
    const { threadId, encoding: contentEncoding, source, ...file } = args;
    const { runner, rootPath } = await located(threadId, file.path, source);
    const options = { rootPath, contentEncoding, createParents: true };
    const result = await runner.call(machineFiles.write, {
      ...file,
      ...options,
    });
    if (result.outcome === "conflict") return { outcome: "conflict" as const };
    return { outcome: "written" as const, sha256: result.sha256 };
  });
  bb.implement(
    files.list,
    async ({ threadId, path, directories, source, ...query }) => {
      const base = await based(
        threadId,
        path === undefined ? [] : [path],
        source,
      );
      const { hostId } = base;
      const rootPath = resolve(base.path ?? "/", path ?? ".");
      const kinds = { includeFiles: true, includeDirectories: directories };
      const search = { ...query, ...kinds, includeHidden: true, rootPath };
      const { paths, truncated } = await runners
        .get(hostId)
        .call(machineFiles.list, search);
      const listed = paths.map(({ path: found, name }) => ({
        path: found,
        name,
      }));
      return { paths: listed, truncated };
    },
  );
  bb.implement(files.mkdir, async ({ threadId, path, source }) => {
    const { runner, rootPath } = await located(threadId, path, source);
    await runner.call(machineFiles.mutate, {
      op: "mkdir",
      path,
      rootPath,
      recursive: true,
    });
  });
  bb.implement(files.delete, async ({ threadId, path, recursive, source }) => {
    const { runner, rootPath } = await located(threadId, path, source);
    await runner.call(machineFiles.mutate, {
      op: "remove",
      path,
      rootPath,
      recursive,
    });
  });
  bb.implement(files.move, async ({ threadId, from, to, source }) => {
    const { hostId, path } = await based(threadId, [from, to], source);
    const rootPath = path ?? undefined;
    const move = { sourcePath: from, destinationPath: to, rootPath };
    await runners
      .get(hostId)
      .call(machineFiles.mutate, { op: "move", ...move });
  });
  bb.onStart(() => startWorkspaceWatch(bb));
}
