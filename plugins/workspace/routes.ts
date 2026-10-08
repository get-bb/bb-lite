import type { PluginServerApi } from "@bb/plugin";
import { publicApiRoutes } from "@bb/server-contract";
import {
  PATH_LIST_EXCLUDED_NAMES,
  PATH_LIST_LIMIT_DEFAULT,
  requireReadyEnvironment,
  requireThreadEnvironment,
} from "@bb/server-kit/environments/workspace";
import { requireHost } from "@bb/server-kit/runners/hosts";
import { typedApi, type ApiApp } from "@bb/server-kit/http/api";
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
  const { get, post } = typedApi(app);
  const { environments, files, hosts, threads } = publicApiRoutes;

  const runnerOf = (hostId: string | undefined) =>
    bb.runners.get(requireHost(bb, hostId ?? bb.config.hostId).id);

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

  get(environments.file, (c) =>
    serve(c, requireReadyEnvironment(bb, c.req.param("id"))),
  );

  get(environments.revisionFile, (c) => {
    const gitRef = revisionRef(c.req.param("ref"));
    return serve(c, requireReadyEnvironment(bb, c.req.param("id")), gitRef);
  });

  get(threads.hostFile, (c) => {
    const { hostId } = requireThreadEnvironment(bb, c.req.param("id"));
    return serve(c, { hostId, path: HOST_ROOT });
  });

  get(hosts.directory, async (c, { path }) =>
    c.json(await runnerOf(c.req.param("id")).browseDirectory({ path })),
  );

  post(hosts.pathsExist, async (c, { paths }) =>
    c.json(await runnerOf(c.req.param("id")).pathsExist({ paths })),
  );

  post(files.read, async (c, { hostId, ...location }) =>
    c.json(await runnerOf(hostId).readFile(location)),
  );

  post(files.write, async (c, { hostId, ...write }) =>
    c.json(await runnerOf(hostId).writeFile(write)),
  );

  post(files.list, async (c, { hostId, path: rootPath, ...query }) => {
    const kinds = { includeFiles: true, includeDirectories: false };
    const search = { ...LIST_DEFAULTS, ...query, ...kinds, rootPath };
    const { paths, truncated } = await runnerOf(hostId).listPaths(search);
    const listed = paths.map(({ path, name }) => ({ path, name }));
    return c.json({ files: listed, truncated });
  });
}
