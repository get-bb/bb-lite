import { rm } from "node:fs/promises";
import type { ServerContext } from "../context.js";
import { deleteProject, type DeletedProject } from "../db/projects.js";
import { projectAttachmentsDir } from "./attachments.js";

export type ProjectDeletedHook = (
  ctx: ServerContext,
  deleted: DeletedProject,
) => void | Promise<void>;

export const onProjectDeleted: ProjectDeletedHook[] = [];

async function runProjectDeletedHooks(
  ctx: ServerContext,
  deleted: DeletedProject,
): Promise<void> {
  const { projectId } = deleted;
  for (const hook of onProjectDeleted) {
    try {
      await hook(ctx, deleted);
    } catch (error) {
      ctx.log.error("Project deletion hook failed", { err: error, projectId });
    }
  }
}

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
  void runProjectDeletedHooks(ctx, deleted);
}
