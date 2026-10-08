import { rm } from "node:fs/promises";
import { asSystem } from "@bb/server-kit/auth/actor";
import type { ServerContext } from "@bb/server-kit/context";
import { deleteProject } from "@bb/server-kit/db/projects";
import { removeProjectWorkspaces } from "@bb/server-kit/environments/workspace";
import { projectAttachmentsDir } from "@bb/server-kit/projects/attachments";

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
  void asSystem(() =>
    removeProjectWorkspaces(ctx, deleted)
      .catch(failed)
      .then(() => ctx.threads.releaseDeletedProject(deleted))
      .catch(failed),
  );
}
