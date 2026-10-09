import { git } from "@bb/runner";
import { environments, threads, type PluginServerApi } from "@bb/plugin";
import type { WorkspaceDiffTarget } from "@bb/domain";
import { RunnerError } from "@bb/runner";
import type { EnvironmentDiffQuery } from "@bb/server-contract";
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
import { inferCommitMessage } from "./commit-message.js";
import { listEnvironmentProviders } from "./environment-providers.js";
import { ApiError, conflict, invalidRequest } from "@bb/server-kit/http/errors";

const COMMIT_MESSAGE = "bb: automated commit";

function diffTarget(query: EnvironmentDiffQuery): WorkspaceDiffTarget {
  if (query.target === "uncommitted") return { type: "uncommitted" };
  if (query.target === "commit") return { type: "commit", sha: query.sha };
  return { type: query.target, mergeBaseBranch: query.mergeBaseBranch };
}

function pageBound(value: number | undefined, minimum: number, name: string) {
  if (value === undefined || value >= minimum) return value;
  throw invalidRequest(`${name} must be at least ${minimum}`);
}

export function implementEnvironments(
  bb: PluginServerApi,
  remove: (environmentId: string) => Promise<void>,
): void {
  const { db, realtime: hub, runners } = bb;

  bb.implement(environments.providers, async (query) => ({
    providers: await listEnvironmentProviders(bb, query),
  }));

  bb.implement(environments.list, ({ limit, offset, ...filter }) => {
    const page = {
      limit: pageBound(limit, 1, "limit"),
      offset: pageBound(offset, 0, "offset"),
    };
    return listEnvironments(db, { ...filter, ...page });
  });

  bb.implement(environments.get, ({ environmentId }) =>
    requireEnvironment(bb, environmentId),
  );

  bb.implement(environments.update, ({ environmentId, ...changes }) => {
    const { id } = requireEnvironment(bb, environmentId);
    updateEnvironment(db, id, changes);
    hub.environment(id, ["metadata-changed"]);
    return requireEnvironment(bb, id);
  });

  bb.implement(environments.delete, async ({ environmentId }) => {
    const { id } = requireEnvironment(bb, environmentId);
    if (listEnvironmentThreadIds(db, id, "unarchived").length > 0) {
      throw conflict("Environment still has live threads");
    }
    await remove(id);
  });

  bb.implement(environments.archiveThreads, async ({ environmentId }) => {
    const { id } = requireEnvironment(bb, environmentId);
    const archivedThreadIds = listEnvironmentThreadIds(db, id, "unarchived");
    for (const threadId of archivedThreadIds) {
      await bb.call(threads.archive, { threadId });
    }
    return { ok: true as const, archivedThreadIds };
  });

  bb.implement(environments.status, ({ environmentId, mergeBaseBranch }) =>
    readGitWorkspace(bb, environmentId, "status", async (runner, found) => {
      const { path } = found;
      const workspace = await runner.call(git.status, {
        path,
        mergeBaseBranch,
      });
      const { currentBranch: branchName, defaultBranch } = workspace.branch;
      const observed = { branchName, defaultBranch: defaultBranch || null };
      recordWorkspaceMetadata(bb, found, observed);
      return { workspace };
    }),
  );

  bb.implement(environments.diffFiles, ({ environmentId, ...query }) => {
    const target = diffTarget(query);
    return readGitWorkspace(bb, environmentId, "diff", (runner, { path }) =>
      runner.call(git.diffFiles, { path, target }),
    );
  });

  bb.implement(environments.diffPatch, ({ environmentId, target, paths }) =>
    readGitWorkspace(bb, environmentId, "diff", (runner, { path }) =>
      runner.call(git.diffPatch, { path, target, paths }),
    ),
  );

  bb.implement(environments.diffFile, async ({ environmentId, ...file }) => {
    const { hostId, path } = requireReadyEnvironment(bb, environmentId);
    const read = await runners.get(hostId).call(git.diffFile, { path, file });
    const { content, contentEncoding, mimeType, sizeBytes } = read;
    const described = mimeType === undefined ? {} : { mimeType };
    const body = { path: read.path, content, contentEncoding, sizeBytes };
    return { ...body, ...described };
  });

  bb.implement(environments.diffBranches, ({ environmentId, ...query }) => {
    const { hostId, path } = requireReadyEnvironment(bb, environmentId);
    return runners
      .get(hostId)
      .call(git.branches, { path, ...branchSearch(query) });
  });

  bb.implement(environments.paths, ({ environmentId, ...query }) => {
    const environment = requireReadyEnvironment(bb, environmentId);
    return searchWorkspacePaths(bb, environment, query);
  });

  bb.implement(environments.commitMessage, async ({ environmentId }, ctx) => {
    requireReadyEnvironment(bb, environmentId);
    const message = await inferCommitMessage(bb, environmentId, ctx.signal);
    return { message };
  });

  bb.implement(environments.runAction, async ({ environmentId }) => {
    const { id, hostId, path } = requireReadyEnvironment(bb, environmentId);
    const inferred = await inferCommitMessage(bb, environmentId).catch(
      (err: unknown) => {
        bb.log.warn("Could not infer a commit message", { err });
        return null;
      },
    );
    try {
      const runner = runners.get(hostId);
      const commit = await runner.call(git.commit, {
        path,
        message: inferred ?? COMMIT_MESSAGE,
      });
      hub.environment(id, ["work-status-changed", "git-refs-changed"]);
      const message = `Created commit ${commit.commitSha}`;
      return {
        ok: true as const,
        action: "commit" as const,
        message,
        ...commit,
      };
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
