import { publicApiRoutes } from "@bb/server-contract";
import type { ServerContext } from "../../context.js";
import {
  PATH_LIST_EXCLUDED_NAMES,
  PATH_LIST_LIMIT_DEFAULT,
  requireReadyEnvironment,
  requireThreadEnvironment,
} from "../../environments/workspace.js";
import { requireProjectWorkspace } from "../../projects/workspace.js";
import { requireHost } from "../../runners/hosts.js";
import { typedApi, type ApiApp } from "../api.js";
import {
  relativeFileSegments,
  revisionRef,
  serveFileBytes,
} from "../file-bytes.js";

interface FileRequest {
  req: { raw: Request; param(name: "filePath"): string };
}

const HOST_ROOT = "/";
const LIST_DEFAULTS = {
  limit: PATH_LIST_LIMIT_DEFAULT,
  includeHidden: true,
  excludeNames: PATH_LIST_EXCLUDED_NAMES,
};

export function registerFileRoutes(app: ApiApp, ctx: ServerContext): void {
  const { get, post } = typedApi(app);
  const { environments, files, hosts, projects, threads } = publicApiRoutes;

  const runnerOf = (hostId: string | undefined) =>
    ctx.runners.get(requireHost(ctx, hostId ?? ctx.config.hostId).id);

  const serve = (
    c: FileRequest,
    root: { hostId: string; path: string },
    gitRef?: string,
  ) => {
    const segments = relativeFileSegments(c.req.param("filePath"));
    const { hostId, path: rootPath } = root;
    const target = { hostId, rootPath, segments, gitRef };
    return serveFileBytes(ctx, c.req.raw, target);
  };

  get(environments.file, (c) =>
    serve(c, requireReadyEnvironment(ctx, c.req.param("id"))),
  );

  get(environments.revisionFile, (c) => {
    const gitRef = revisionRef(c.req.param("ref"));
    return serve(c, requireReadyEnvironment(ctx, c.req.param("id")), gitRef);
  });

  get(projects.file, (c) =>
    serve(c, requireProjectWorkspace(ctx, c.req.param("id"), {})),
  );

  get(projects.hostFile, (c) => {
    const hostId = c.req.param("hostId");
    return serve(
      c,
      requireProjectWorkspace(ctx, c.req.param("id"), { hostId }),
    );
  });

  get(threads.hostFile, (c) => {
    const { hostId } = requireThreadEnvironment(ctx, c.req.param("id"));
    return serve(c, { hostId, path: HOST_ROOT });
  });

  get(hosts.directory, async (c, { path }) =>
    c.json(await runnerOf(c.req.param("id")).browseDirectory({ path })),
  );

  post(hosts.pathsExist, async (c, { paths }) =>
    c.json(await runnerOf(c.req.param("id")).pathsExist({ paths })),
  );

  post(files.read, async (c, { hostId, ...location }) => {
    const file = await runnerOf(hostId).readFile(location);
    if ("notModified" in file)
      throw new Error("Unconditional read was skipped");
    return c.json(file);
  });

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

  post(files.mkdir, async (c, { hostId, ...target }) =>
    c.json(await runnerOf(hostId).mutatePath({ op: "mkdir", ...target })),
  );
}
