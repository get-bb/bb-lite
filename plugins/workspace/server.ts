import { isAbsolute, resolve } from "node:path";
import { files, type PluginServerApi } from "@bb/plugin";
import { RunnerError } from "@bb/runner";
import { coreOf } from "@bb/server-kit/host";
import { registerFileRoutes } from "./routes.js";
import { startWorkspaceWatch } from "./watch.js";

export default function workspace(bb: PluginServerApi): void {
  const { ctx, routes } = coreOf(bb);
  const { runners } = ctx;
  const located = (threadId: string, path: string) => {
    const { hostId, path: workspacePath } = ctx.threads.workspaceOf(threadId);
    const rootPath = isAbsolute(path) ? undefined : workspacePath;
    return { runner: runners.get(hostId), rootPath };
  };
  routes(registerFileRoutes);
  bb.implement(files.read, async (args) => {
    const { threadId, path, encoding = "utf8" } = args;
    const { runner, rootPath } = located(threadId, path);
    const missing = (error: unknown) => {
      const absent = error instanceof RunnerError;
      if (absent && error.code === "path_not_found") return null;
      throw error;
    };
    const file = await runner.readFile({ path, rootPath }).catch(missing);
    if (file === null || !("content" in file)) return null;
    const bytes = Buffer.from(file.content, file.contentEncoding);
    return { content: bytes.toString(encoding), sha256: file.sha256 };
  });
  bb.implement(files.write, async (args) => {
    const { threadId, encoding: contentEncoding, ...file } = args;
    const { runner, rootPath } = located(threadId, file.path);
    const options = { rootPath, contentEncoding, createParents: true };
    const result = await runner.writeFile({ ...file, ...options });
    if (result.outcome === "conflict") return { outcome: "conflict" as const };
    return { outcome: "written" as const, sha256: result.sha256 };
  });
  bb.implement(
    files.list,
    async ({ threadId, path, directories, ...query }) => {
      const { hostId, path: workspacePath } = ctx.threads.workspaceOf(threadId);
      const rootPath =
        path === undefined ? workspacePath : resolve(workspacePath, path);
      const kinds = { includeFiles: true, includeDirectories: directories };
      const search = { ...query, ...kinds, includeHidden: true, rootPath };
      const { paths, truncated } = await runners.get(hostId).listPaths(search);
      const listed = paths.map(({ path: found, name }) => ({
        path: found,
        name,
      }));
      return { paths: listed, truncated };
    },
  );
  bb.implement(files.mkdir, async ({ threadId, path }) => {
    const { runner, rootPath } = located(threadId, path);
    await runner.mutatePath({ op: "mkdir", path, rootPath, recursive: true });
  });
  bb.implement(files.remove, async ({ threadId, path, recursive }) => {
    const { runner, rootPath } = located(threadId, path);
    await runner.mutatePath({ op: "remove", path, rootPath, recursive });
  });
  bb.implement(files.move, async ({ threadId, from, to }) => {
    const { hostId, path: rootPath } = ctx.threads.workspaceOf(threadId);
    const move = { sourcePath: from, destinationPath: to, rootPath };
    await runners.get(hostId).mutatePath({ op: "move", ...move });
  });
  bb.onStart(() => startWorkspaceWatch(ctx));
}
