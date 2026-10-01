import type { ServerContext } from "../context.js";

export type ProjectPathInspection =
  | "unknown"
  | { exists: boolean; isGitRepo: boolean; gitRemoteUrl: string | null };

export async function inspectProjectPath(
  ctx: ServerContext,
  hostId: string,
  path: string,
): Promise<ProjectPathInspection> {
  if (!ctx.runners.isConnected(hostId)) return "unknown";
  try {
    const found = await ctx.runners.get(hostId).inspectPath({ path });
    const { exists, isGitRepo, remoteUrl: gitRemoteUrl } = found;
    return { exists, isGitRepo, gitRemoteUrl };
  } catch {
    return "unknown";
  }
}

export async function inspectGitRemoteUrl(
  ctx: ServerContext,
  hostId: string,
  path: string,
): Promise<string | null> {
  const inspection = await inspectProjectPath(ctx, hostId, path);
  return inspection === "unknown" ? null : inspection.gitRemoteUrl;
}
