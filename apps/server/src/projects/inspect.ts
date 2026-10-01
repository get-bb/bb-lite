import type { ServerContext } from "../context.js";

export type ProjectPathInspection =
  | "unknown"
  | { exists: boolean; isGitRepo: boolean; gitRemoteUrl: string | null };

export function inspectProjectPath(
  _ctx: ServerContext,
  _hostId: string,
  _path: string,
): Promise<ProjectPathInspection> {
  return Promise.resolve("unknown");
}

export async function inspectGitRemoteUrl(
  ctx: ServerContext,
  hostId: string,
  path: string,
): Promise<string | null> {
  const inspection = await inspectProjectPath(ctx, hostId, path);
  return inspection === "unknown" ? null : inspection.gitRemoteUrl;
}
