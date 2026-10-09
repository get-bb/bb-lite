import { machineFiles } from "@bb/runner";
import { isAbsolute, resolve } from "node:path";
import { files, threads, type PluginServerApi } from "@bb/plugin";
import { RunnerError } from "@bb/runner";
import { implementMachineFiles, registerFileRoutes } from "./routes.js";
import { startWorkspaceWatch } from "./watch.js";

export default function workspace(bb: PluginServerApi): void {
  const { runners } = bb;
  const workspaceOf = (threadId: string) =>
    bb.call(threads.workspace, { threadId });
  const located = async (threadId: string, path: string) => {
    const { hostId, path: workspacePath } = await workspaceOf(threadId);
    const rootPath = isAbsolute(path) ? undefined : workspacePath;
    return { runner: runners.get(hostId), rootPath };
  };
  bb.http.api((app) => registerFileRoutes(app, bb));
  implementMachineFiles(bb);
  bb.implement(files.read, async (args) => {
    const { threadId, path, encoding = "utf8" } = args;
    const { runner, rootPath } = await located(threadId, path);
    const missing = (error: unknown) => {
      const absent = error instanceof RunnerError;
      if (absent && error.code === "path_not_found") return null;
      throw error;
    };
    const file = await runner
      .call(machineFiles.read, { path, rootPath })
      .catch(missing);
    if (file === null || !("content" in file)) return null;
    const bytes = Buffer.from(file.content, file.contentEncoding);
    return { content: bytes.toString(encoding), sha256: file.sha256 };
  });
  bb.implement(files.write, async (args) => {
    const { threadId, encoding: contentEncoding, ...file } = args;
    const { runner, rootPath } = await located(threadId, file.path);
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
    async ({ threadId, path, directories, ...query }) => {
      const { hostId, path: workspacePath } = await workspaceOf(threadId);
      const rootPath =
        path === undefined ? workspacePath : resolve(workspacePath, path);
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
  bb.implement(files.mkdir, async ({ threadId, path }) => {
    const { runner, rootPath } = await located(threadId, path);
    await runner.call(machineFiles.mutate, {
      op: "mkdir",
      path,
      rootPath,
      recursive: true,
    });
  });
  bb.implement(files.delete, async ({ threadId, path, recursive }) => {
    const { runner, rootPath } = await located(threadId, path);
    await runner.call(machineFiles.mutate, {
      op: "remove",
      path,
      rootPath,
      recursive,
    });
  });
  bb.implement(files.move, async ({ threadId, from, to }) => {
    const { hostId, path: rootPath } = await workspaceOf(threadId);
    const move = { sourcePath: from, destinationPath: to, rootPath };
    await runners
      .get(hostId)
      .call(machineFiles.mutate, { op: "move", ...move });
  });
  bb.onStart(() => startWorkspaceWatch(bb));
}
