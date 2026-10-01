import { BRANCH_LIST_LIMIT_MAX, type GitSourceInspection } from "@bb/domain";
import {
  publicApiRoutes,
  type ProjectBranchesQuery,
  type ProjectBranchesResponse,
} from "@bb/server-contract";
import type { ServerContext } from "../../context.js";
import {
  boundedLimit,
  searchWorkspacePaths,
} from "../../environments/workspace.js";
import { requireStandardProject } from "../../projects/require.js";
import {
  findProjectWorkspace,
  requireProjectWorkspace,
} from "../../projects/workspace.js";
import { findProviderDefinition } from "../../providers/catalog.js";
import { typedApi, type ApiApp } from "../api.js";

const BRANCH_LIST_LIMIT_DEFAULT = 50;

function defaultWorktreeBaseBranch(source: GitSourceInspection): string | null {
  const { defaultBranch, originDefaultBranch, defaultBranchRelation } = source;
  if (originDefaultBranch === null) return defaultBranch;
  const localIsAhead =
    defaultBranch !== null &&
    defaultBranchRelation !== "equal" &&
    defaultBranchRelation !== "local-behind";
  return localIsAhead ? defaultBranch : originDefaultBranch;
}

export function registerProjectWorkspaceRoutes(
  app: ApiApp,
  ctx: ServerContext,
): void {
  const { get } = typedApi(app);
  const routes = publicApiRoutes.projects;
  const { db, runners } = ctx;

  const readBranches = async (
    projectId: string,
    query: ProjectBranchesQuery,
  ): Promise<ProjectBranchesResponse> => {
    requireStandardProject(db, projectId);
    const { hostId: on, selectedBranch } = query;
    const { hostId, path } = requireProjectWorkspace(ctx, projectId, {
      hostId: on,
    });
    const runner = runners.get(hostId);
    const bounds = {
      fallback: BRANCH_LIST_LIMIT_DEFAULT,
      max: BRANCH_LIST_LIMIT_MAX,
    };
    const limit = boundedLimit(query.limit, bounds);
    const matching = query.query?.trim() || undefined;
    const [source, branches] = await Promise.all([
      runner.inspectGitSource({ path }),
      runner.listBranches({ path, query: matching, selectedBranch, limit }),
    ]);
    const defaultBase = defaultWorktreeBaseBranch(source);
    return { ...source, ...branches, defaultWorktreeBaseBranch: defaultBase };
  };

  get(routes.paths, async (c, query) => {
    const workspace = requireProjectWorkspace(ctx, c.req.param("id"), query);
    return c.json(await searchWorkspacePaths(ctx, workspace, query));
  });

  get(routes.commands, async (c, query) => {
    const projectId = c.req.param("id");
    const { hostId, path: cwd } = findProjectWorkspace(ctx, projectId, query);
    const provider = findProviderDefinition(db, query.provider);
    if (provider === undefined) return c.json({ commands: [] });
    const providerId = provider.id;
    return c.json(await runners.get(hostId).listCommands({ providerId, cwd }));
  });

  get(routes.branches, async (c, query) =>
    c.json(await readBranches(c.req.param("id"), query)),
  );

  get(routes.branchOptions, async (c, query) =>
    c.json(await readBranches(c.req.param("id"), query)),
  );
}
