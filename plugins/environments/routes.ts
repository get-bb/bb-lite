import {
  environments as environmentOps,
  threads as threadOps,
} from "@bb/plugin";
import type { PluginServerApi } from "@bb/plugin";
import type { WorkspaceDiffTarget } from "@bb/domain";
import { RunnerError } from "@bb/runner";
import {
  publicApiRoutes,
  type EnvironmentDiffQuery,
} from "@bb/server-contract";
import {
  listEnvironments,
  listEnvironmentThreadIds,
  updateEnvironment,
} from "@bb/server-kit/db/environments";
import {
  branchSearch,
  readGitWorkspace,
  recordWorkspaceMetadata,
  requireEnvironment,
  requireReadyEnvironment,
  searchWorkspacePaths,
  workspaceFailure,
} from "@bb/server-kit/environments/workspace";
import { typedApi, type ApiApp } from "@bb/server-kit/http/api";
import { listEnvironmentProviders } from "./environment-providers.js";
import { ApiError, conflict, invalidRequest } from "@bb/server-kit/http/errors";

const COMMIT_MESSAGE = "bb: automated commit";

function diffTarget(query: EnvironmentDiffQuery): WorkspaceDiffTarget {
  if (query.target === "uncommitted") return { type: "uncommitted" };
  if (query.target === "commit") return { type: "commit", sha: query.sha };
  return { type: query.target, mergeBaseBranch: query.mergeBaseBranch };
}

function pageBound(value: string | undefined, minimum: number, name: string) {
  if (value === undefined) return undefined;
  if (Number(value) >= minimum) return Number(value);
  throw invalidRequest(`${name} must be at least ${minimum}`);
}

export function registerEnvironmentRoutes(
  app: ApiApp,
  bb: PluginServerApi,
): void {
  const { del, get, patch, post } = typedApi(app);
  const routes = publicApiRoutes.environments;
  const { db, realtime: hub, runners } = bb;
  const { system } = publicApiRoutes;

  get(system.environmentProviders, async (c, query) =>
    c.json({ providers: await listEnvironmentProviders(bb, query) }),
  );

  get(routes.list, (c, query) => {
    const { limit, offset, ...filter } = query;
    const page = {
      limit: pageBound(limit, 1, "limit"),
      offset: pageBound(offset, 0, "offset"),
    };
    return c.json(listEnvironments(db, { ...filter, ...page }));
  });

  get(routes.get, (c) => c.json(requireEnvironment(bb, c.req.param("id"))));

  patch(routes.update, (c, payload) => {
    const { id } = requireEnvironment(bb, c.req.param("id"));
    updateEnvironment(db, id, payload);
    hub.environment(id, ["metadata-changed"]);
    return c.json(requireEnvironment(bb, id));
  });

  del(routes.delete, async (c) => {
    const { id } = requireEnvironment(bb, c.req.param("id"));
    if (listEnvironmentThreadIds(db, id, "unarchived").length > 0) {
      throw conflict("Environment still has live threads");
    }
    await bb.call(environmentOps.delete, { environmentId: id });
    return c.json({ ok: true });
  });

  post(routes.archiveThreads, async (c) => {
    const { id } = requireEnvironment(bb, c.req.param("id"));
    const archivedThreadIds = listEnvironmentThreadIds(db, id, "unarchived");
    for (const threadId of archivedThreadIds) {
      await bb.call(threadOps.archive, { threadId });
    }
    return c.json({ ok: true, archivedThreadIds });
  });

  get(routes.status, async (c, { mergeBaseBranch }) => {
    const id = c.req.param("id");
    const read = readGitWorkspace(bb, id, "status", async (runner, found) => {
      const { path } = found;
      const workspace = await runner.gitStatus({ path, mergeBaseBranch });
      const { currentBranch: branchName, defaultBranch } = workspace.branch;
      const observed = { branchName, defaultBranch: defaultBranch || null };
      recordWorkspaceMetadata(bb, found, observed);
      return { workspace };
    });
    return c.json(await read);
  });

  get(routes.diffFiles, async (c, query) => {
    const target = diffTarget(query);
    const id = c.req.param("id");
    const read = readGitWorkspace(bb, id, "diff", (runner, { path }) =>
      runner.gitDiffFiles({ path, target }),
    );
    return c.json(await read);
  });

  post(routes.diffPatch, async (c, { target, paths }) => {
    const id = c.req.param("id");
    const read = readGitWorkspace(bb, id, "diff", (runner, { path }) =>
      runner.gitDiffPatch({ path, target, paths }),
    );
    return c.json(await read);
  });

  get(routes.diffFile, async (c, file) => {
    const { hostId, path } = requireReadyEnvironment(bb, c.req.param("id"));
    const read = await runners.get(hostId).gitDiffFile({ path, file });
    const { content, contentEncoding, mimeType, sizeBytes } = read;
    const described = mimeType === undefined ? {} : { mimeType };
    const body = { path: read.path, content, contentEncoding, sizeBytes };
    return c.json({ ...body, ...described });
  });

  get(routes.diffBranches, async (c, query) => {
    const { hostId, path } = requireReadyEnvironment(bb, c.req.param("id"));
    const runner = runners.get(hostId);
    const search = { path, ...branchSearch(query) };
    return c.json(await runner.listBranches(search));
  });

  get(routes.paths, async (c, query) => {
    const environment = requireReadyEnvironment(bb, c.req.param("id"));
    return c.json(await searchWorkspacePaths(bb, environment, query));
  });

  post(routes.actions, async (c) => {
    const { id, hostId, path } = requireReadyEnvironment(bb, c.req.param("id"));
    try {
      const runner = runners.get(hostId);
      const commit = await runner.gitCommit({ path, message: COMMIT_MESSAGE });
      hub.environment(id, ["work-status-changed", "git-refs-changed"]);
      const message = `Created commit ${commit.commitSha}`;
      return c.json({ ok: true, action: "commit", message, ...commit });
    } catch (error) {
      if (error instanceof RunnerError && error.code === "no_changes") {
        const message = "No uncommitted changes to commit";
        throw new ApiError(409, "no_changes", message);
      }
      const failure = workspaceFailure(path, error);
      if (failure === null) throw error;
      const details = { kind: "workspace_unavailable", failure };
      const { message } = failure;
      throw new ApiError(409, "workspace_unavailable", message, { details });
    }
  });
}
