import type { WorkspaceDiffTarget } from "@bb/domain";
import { RunnerError } from "@bb/runner";
import {
  publicApiRoutes,
  type EnvironmentDiffQuery,
} from "@bb/server-contract";
import type { ServerContext } from "../../context.js";
import {
  listEnvironments,
  listEnvironmentThreadIds,
  updateEnvironment,
} from "../../db/environments.js";
import {
  branchSearch,
  readGitWorkspace,
  recordWorkspaceMetadata,
  requireEnvironment,
  requireReadyEnvironment,
  searchWorkspacePaths,
  workspaceFailure,
} from "../../environments/workspace.js";
import { typedApi, type ApiApp } from "../api.js";
import { ApiError, conflict, invalidRequest } from "../errors.js";

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
  ctx: ServerContext,
): void {
  const { del, get, patch, post } = typedApi(app);
  const routes = publicApiRoutes.environments;
  const { db, hub, runners, threads } = ctx;

  get(routes.list, (c, query) => {
    const { limit, offset, ...filter } = query;
    const page = {
      limit: pageBound(limit, 1, "limit"),
      offset: pageBound(offset, 0, "offset"),
    };
    return c.json(listEnvironments(db, { ...filter, ...page }));
  });

  get(routes.get, (c) => c.json(requireEnvironment(ctx, c.req.param("id"))));

  patch(routes.update, (c, payload) => {
    const { id } = requireEnvironment(ctx, c.req.param("id"));
    updateEnvironment(db, id, payload);
    hub.environment(id, ["metadata-changed"]);
    return c.json(requireEnvironment(ctx, id));
  });

  del(routes.delete, async (c) => {
    const { id } = requireEnvironment(ctx, c.req.param("id"));
    if (listEnvironmentThreadIds(db, id, "unarchived").length > 0) {
      throw conflict("Environment still has live threads");
    }
    await ctx.environments.remove(id);
    return c.json({ ok: true });
  });

  post(routes.archiveThreads, async (c) => {
    const { id } = requireEnvironment(ctx, c.req.param("id"));
    const archivedThreadIds = listEnvironmentThreadIds(db, id, "unarchived");
    for (const threadId of archivedThreadIds) await threads.archive(threadId);
    return c.json({ ok: true, archivedThreadIds });
  });

  get(routes.status, async (c, { mergeBaseBranch }) => {
    const id = c.req.param("id");
    const read = readGitWorkspace(ctx, id, "status", async (runner, found) => {
      const { path } = found;
      const workspace = await runner.gitStatus({ path, mergeBaseBranch });
      const { currentBranch: branchName, defaultBranch } = workspace.branch;
      const observed = { branchName, defaultBranch: defaultBranch || null };
      recordWorkspaceMetadata(ctx, found, observed);
      return { workspace };
    });
    return c.json(await read);
  });

  get(routes.diff, async (c, query) => {
    const target = diffTarget(query);
    const id = c.req.param("id");
    const read = readGitWorkspace(
      ctx,
      id,
      "diff",
      async (runner, { path }) => ({
        diff: await runner.gitDiff({ path, target }),
      }),
    );
    return c.json(await read);
  });

  get(routes.diffFiles, async (c, query) => {
    const target = diffTarget(query);
    const id = c.req.param("id");
    const read = readGitWorkspace(ctx, id, "diff", (runner, { path }) =>
      runner.gitDiffFiles({ path, target }),
    );
    return c.json(await read);
  });

  post(routes.diffPatch, async (c, { target, paths }) => {
    const id = c.req.param("id");
    const read = readGitWorkspace(ctx, id, "diff", (runner, { path }) =>
      runner.gitDiffPatch({ path, target, paths }),
    );
    return c.json(await read);
  });

  get(routes.diffFile, async (c, file) => {
    const { hostId, path } = requireReadyEnvironment(ctx, c.req.param("id"));
    const read = await runners.get(hostId).gitDiffFile({ path, file });
    const { content, contentEncoding, mimeType, sizeBytes } = read;
    const described = mimeType === undefined ? {} : { mimeType };
    const body = { path: read.path, content, contentEncoding, sizeBytes };
    return c.json({ ...body, ...described });
  });

  get(routes.diffBranches, async (c, query) => {
    const { hostId, path } = requireReadyEnvironment(ctx, c.req.param("id"));
    const runner = runners.get(hostId);
    const search = { path, ...branchSearch(query) };
    return c.json(await runner.listBranches(search));
  });

  get(routes.paths, async (c, query) => {
    const environment = requireReadyEnvironment(ctx, c.req.param("id"));
    return c.json(await searchWorkspacePaths(ctx, environment, query));
  });

  post(routes.actions, async (c) => {
    const { id, hostId, path } = requireReadyEnvironment(
      ctx,
      c.req.param("id"),
    );
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
