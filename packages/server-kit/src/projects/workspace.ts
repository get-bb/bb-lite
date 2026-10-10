import { git } from "@bb/runner";
import type { ServerServices } from "../context.js";
import { requireProject, withSources } from "../db/projects.js";
import { requireEnvironment } from "../environments/workspace.js";
import { ApiError } from "../http/errors.js";
import { requireHost } from "../runners/hosts.js";

export interface ProjectWorkspaceSelector {
  hostId?: string;
  environmentId?: string;
}

export interface ProjectWorkspace {
  hostId: string;
  path: string | null;
}

export async function inspectProjectPath(
  ctx: ServerServices,
  hostId: string,
  path: string,
) {
  if (!ctx.runners.isConnected(hostId)) return null;
  const inspecting = ctx.runners.get(hostId).call(git.inspect, { path });
  return inspecting.catch(() => null);
}

export function findProjectWorkspace(
  ctx: ServerServices,
  projectId: string,
  selector: ProjectWorkspaceSelector,
): ProjectWorkspace {
  const [project] = withSources(ctx.db, [requireProject(ctx.db, projectId)]);
  const sources = project?.sources ?? [];
  const sourceOn = (hostId: string) =>
    sources.find((source) => source.hostId === hostId);
  if (selector.environmentId !== undefined) {
    const environment = requireEnvironment(ctx, selector.environmentId);
    const { hostId, status } = environment;
    if (environment.projectId !== projectId) {
      throw new ApiError(404, "environment_not_found", "Environment not found");
    }
    const workspace = status === "ready" ? environment.path : null;
    return { hostId, path: workspace ?? sourceOn(hostId)?.path ?? null };
  }
  if (selector.hostId !== undefined) {
    const { id: hostId } = requireHost(ctx, selector.hostId);
    return { hostId, path: sourceOn(hostId)?.path ?? null };
  }
  const local = ctx.server.hostId;
  const source =
    sourceOn(local) ?? sources.find((candidate) => candidate.isDefault);
  return { hostId: source?.hostId ?? local, path: source?.path ?? null };
}

export function requireProjectWorkspace(
  ctx: ServerServices,
  projectId: string,
  selector: ProjectWorkspaceSelector,
): { hostId: string; path: string } {
  const { hostId, path } = findProjectWorkspace(ctx, projectId, selector);
  if (path !== null) return { hostId, path };
  const status = selector.hostId === undefined ? 409 : 404;
  const message = "Project has no checkout on this machine";
  throw new ApiError(status, "invalid_request", message);
}
