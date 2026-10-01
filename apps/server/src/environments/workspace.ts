import { FILE_LIST_LIMIT_MAX, type Environment } from "@bb/domain";
import { RunnerError } from "@bb/runner";
import type {
  EnvironmentNotReadyErrorDetails,
  EnvironmentStatusResponse,
  PathListIncludeQueryValue,
  ThreadEnvironmentUnavailableErrorDetails,
  WorkspacePathListResponse,
} from "@bb/server-contract";
import type { ServerContext, ServerRunner } from "../context.js";
import {
  findThreadEnvironment,
  getEnvironment,
  updateEnvironment,
} from "../db/environments.js";
import { ApiError, invalidRequest } from "../http/errors.js";

export type ReadyEnvironment = Environment & { path: string };
type Unavailable = Extract<
  EnvironmentStatusResponse,
  { outcome: "unavailable" }
>;
type NotApplicable = Extract<
  EnvironmentStatusResponse,
  { outcome: "not_applicable" }
>;
export type WorkspaceFailure = Unavailable["failure"];
export type WorkspaceMetadata = Partial<
  Pick<Environment, (typeof METADATA_KEYS)[number]>
>;

export interface PathSearchQuery {
  query?: string;
  limit?: string;
  includeFiles: PathListIncludeQueryValue;
  includeDirectories: PathListIncludeQueryValue;
}

const METADATA_KEYS = [
  "branchName",
  "defaultBranch",
  "isGitRepo",
  "isWorktree",
] as const;
const REPORTED_FAILURES = [
  "path_not_found",
  "not_git_repo",
  "permission_denied",
] as const;
export const PATH_LIST_LIMIT_DEFAULT = 1_000;
export const PATH_LIST_EXCLUDED_NAMES = [
  "node_modules",
  ".pnpm-store",
  ".claude/worktrees",
  ".venv",
  "venv",
  ".turbo",
  ".next",
  ".cache",
  "__pycache__",
  ".DS_Store",
];

export function requireEnvironment(
  ctx: ServerContext,
  environmentId: string,
): Environment {
  const environment = getEnvironment(ctx.db, environmentId);
  if (environment === undefined) {
    throw new ApiError(404, "environment_not_found", "Environment not found");
  }
  return environment;
}

export function requireReadyEnvironment(
  ctx: ServerContext,
  environmentId: string,
): ReadyEnvironment {
  const environment = requireEnvironment(ctx, environmentId);
  const { path, status: environmentStatus } = environment;
  if (environmentStatus === "ready" && path) return { ...environment, path };
  const details: EnvironmentNotReadyErrorDetails = {
    environmentStatus,
    hasPath: Boolean(path),
  };
  throw new ApiError(409, "environment_not_ready", "Environment unavailable", {
    details,
  });
}

export function threadEnvironmentId(
  ctx: ServerContext,
  threadId: string,
): string | null {
  const thread = findThreadEnvironment(ctx.db, threadId);
  if (thread === undefined) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
  return thread.environmentId;
}

export function requireThreadEnvironment(
  ctx: ServerContext,
  threadId: string,
): Environment {
  const environmentId = threadEnvironmentId(ctx, threadId);
  if (environmentId !== null) return requireEnvironment(ctx, environmentId);
  const details: ThreadEnvironmentUnavailableErrorDetails = {
    reason: "never_attached",
    environmentStatus: null,
  };
  const message = "Thread has no environment";
  throw new ApiError(409, "thread_environment_unavailable", message, {
    details,
  });
}

export function workspaceFailure(
  workspacePath: string,
  error: unknown,
): WorkspaceFailure | null {
  const { message } = error instanceof Error ? error : { message: "" };
  const offline =
    (error instanceof ApiError && error.body.code === "host_unavailable") ||
    (error instanceof RunnerError && error.code === "unavailable");
  if (offline) return { code: "unknown", workspacePath, message };
  if (!(error instanceof RunnerError)) return null;
  const code = REPORTED_FAILURES.find((reported) => reported === error.code);
  return code === undefined ? null : { code, workspacePath, message };
}

export async function readGitWorkspace<T extends object>(
  ctx: ServerContext,
  environmentId: string,
  subject: "status" | "diff",
  read: (runner: ServerRunner, environment: ReadyEnvironment) => Promise<T>,
): Promise<({ outcome: "available" } & T) | NotApplicable | Unavailable> {
  const environment = requireReadyEnvironment(ctx, environmentId);
  if (!environment.isGitRepo) {
    return {
      outcome: "not_applicable",
      reason: "non_git_environment",
      message: `Workspace ${subject} is not available for non-git environments`,
    };
  }
  try {
    const runner = ctx.runners.get(environment.hostId);
    return { outcome: "available", ...(await read(runner, environment)) };
  } catch (error) {
    const failure = workspaceFailure(environment.path, error);
    if (failure === null) throw error;
    return { outcome: "unavailable", failure };
  }
}

export function recordWorkspaceMetadata(
  ctx: ServerContext,
  environment: Environment,
  observed: WorkspaceMetadata,
): void {
  const differs = METADATA_KEYS.some(
    (key) => observed[key] !== undefined && observed[key] !== environment[key],
  );
  if (!differs) return;
  updateEnvironment(ctx.db, environment.id, observed);
  ctx.hub.environment(environment.id, ["metadata-changed"]);
}

export async function refreshWorkspaceMetadata(
  ctx: ServerContext,
  environment: ReadyEnvironment,
): Promise<void> {
  const runner = ctx.runners.get(environment.hostId);
  const { exists, ...found } = await runner.inspectPath({
    path: environment.path,
  });
  if (!exists) return;
  const { branchName, defaultBranch, isGitRepo, isWorktree } = found;
  const observed = { branchName, defaultBranch, isGitRepo, isWorktree };
  recordWorkspaceMetadata(ctx, environment, observed);
}

export function boundedLimit(
  value: string | undefined,
  bounds: { fallback: number; max: number },
): number {
  const limit = Math.min(Number(value ?? bounds.fallback), bounds.max);
  if (limit <= 0) throw invalidRequest("limit must be a positive integer");
  return limit;
}

export function searchWorkspacePaths(
  ctx: ServerContext,
  workspace: { hostId: string; path: string },
  query: PathSearchQuery,
): Promise<WorkspacePathListResponse> {
  const includeFiles = query.includeFiles === "true";
  const includeDirectories = query.includeDirectories === "true";
  if (!includeFiles && !includeDirectories) {
    throw invalidRequest("At least one path kind must be included");
  }
  return ctx.runners.get(workspace.hostId).listPaths({
    rootPath: workspace.path,
    query: query.query,
    limit: boundedLimit(query.limit, {
      fallback: PATH_LIST_LIMIT_DEFAULT,
      max: FILE_LIST_LIMIT_MAX,
    }),
    includeFiles,
    includeDirectories,
    includeHidden: true,
    excludeNames: PATH_LIST_EXCLUDED_NAMES,
  });
}
