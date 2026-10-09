import { posix } from "node:path";
import { machineFiles } from "@bb/runner";
import { hostFileReadRequestSchema } from "@bb/server-contract";
import { machines, type PluginServerApi } from "@bb/plugin";
import {
  PATH_LIST_EXCLUDED_NAMES,
  PATH_LIST_LIMIT_DEFAULT,
  requireReadyEnvironment,
  requireThreadEnvironment,
} from "@bb/server-kit/environments/workspace";
import { requireHost } from "@bb/server-kit/runners/hosts";
import { requireValid, type ApiApp } from "@bb/server-kit/http/api";
import {
  relativeFileSegments,
  revisionRef,
  serveFileBytes,
} from "@bb/server-kit/http/file-bytes";

interface FileRequest {
  req: { raw: Request; param(name: "filePath"): string };
}

const HOST_ROOT = "/";
const LIST_DEFAULTS = {
  limit: PATH_LIST_LIMIT_DEFAULT,
  includeHidden: true,
  excludeNames: PATH_LIST_EXCLUDED_NAMES,
};

export function registerFileRoutes(app: ApiApp, bb: PluginServerApi): void {
  const serve = (
    c: FileRequest,
    root: { hostId: string; path: string },
    gitRef?: string,
  ) => {
    const segments = relativeFileSegments(c.req.param("filePath"));
    const { hostId, path: rootPath } = root;
    const target = { hostId, rootPath, segments, gitRef };
    return serveFileBytes(bb, c.req.raw, target);
  };

  app.get("/environments/:environmentId/files/:filePath{.+}", (c) =>
    serve(c, requireReadyEnvironment(bb, c.req.param("environmentId"))),
  );

  app.get(
    "/environments/:environmentId/revisions/:ref/files/:filePath{.+}",
    (c) => {
      const gitRef = revisionRef(c.req.param("ref"));
      const environmentId = c.req.param("environmentId");
      return serve(c, requireReadyEnvironment(bb, environmentId), gitRef);
    },
  );

  app.get("/machines/files/raw", (c) => {
    const query = requireValid(hostFileReadRequestSchema, c.req.query());
    const hostId = requireHost(bb, query.hostId ?? bb.server.hostId).id;
    const root = posix.resolve(HOST_ROOT, query.rootPath ?? HOST_ROOT);
    const within = posix.relative(root, posix.resolve(root, query.path));
    const segments = relativeFileSegments(within);
    const target = { hostId, rootPath: root, segments };
    return serveFileBytes(bb, c.req.raw, target);
  });

  app.get("/threads/:threadId/host-files/:filePath{.+}", (c) => {
    const threadId = c.req.param("threadId");
    const { hostId } = requireThreadEnvironment(bb, threadId);
    return serve(c, { hostId, path: HOST_ROOT });
  });
}

export function implementMachineFiles(bb: PluginServerApi): void {
  const runnerOf = (hostId: string | undefined) =>
    bb.runners.get(requireHost(bb, hostId ?? bb.server.hostId).id);

  bb.implement(machines.directory, ({ hostId, path }) =>
    runnerOf(hostId).call(machineFiles.browse, { path }),
  );

  bb.implement(machines.pathsExist, ({ hostId, paths }) =>
    runnerOf(hostId).call(machineFiles.exist, { paths }),
  );

  bb.implement(machines.readFile, ({ hostId, ...location }) =>
    runnerOf(hostId).call(machineFiles.read, location),
  );

  bb.implement(machines.writeFile, ({ hostId, ...write }) =>
    runnerOf(hostId).call(machineFiles.write, write),
  );

  bb.implement(
    machines.listFiles,
    async ({ hostId, path: rootPath, ...query }) => {
      const kinds = { includeFiles: true, includeDirectories: false };
      const search = { ...LIST_DEFAULTS, ...query, ...kinds, rootPath };
      const { paths, truncated } = await runnerOf(hostId).call(
        machineFiles.list,
        search,
      );
      const listed = paths.map(({ path, name }) => ({ path, name }));
      return { files: listed, truncated };
    },
  );
}
