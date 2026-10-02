import { rm } from "node:fs/promises";
import type { ServerContext } from "../context.js";
import { deleteProject } from "../db/projects.js";
import { removeProjectWorkspaces } from "../environments/manager.js";
import { projectAttachmentsDir } from "./attachments.js";

export async function removeProject(
  ctx: ServerContext,
  projectId: string,
): Promise<void> {
  const deleted = deleteProject(ctx.db, projectId);
  ctx.hub.project(projectId, ["project-deleted"]);
  for (const threadId of deleted.threadIds) {
    ctx.hub.thread(threadId, ["thread-deleted"], { projectId });
  }
  for (const environment of deleted.environments) {
    ctx.hub.environment(environment.id, ["environment-deleted"]);
  }
  const attachments = projectAttachmentsDir(ctx.config.dataDir, projectId);
  await rm(attachments, { recursive: true, force: true });
  const failed = (err: unknown) =>
    ctx.log.error("Project deletion cleanup failed", { err, projectId });
  void removeProjectWorkspaces(ctx, deleted)
    .catch(failed)
    .then(() => ctx.threads.releaseDeletedProject(deleted))
    .catch(failed);
}
