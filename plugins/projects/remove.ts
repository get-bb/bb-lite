import { projects, type PluginServerApi } from "@bb/plugin";
import { rm } from "node:fs/promises";
import { asSystem } from "@bb/server-kit/auth/actor";
import { deleteProject } from "@bb/server-kit/db/projects";
import { removeProjectWorkspaces } from "@bb/server-kit/environments/workspace";
import { projectAttachmentsDir } from "@bb/server-kit/projects/attachments";

export async function removeProject(
  ctx: PluginServerApi,
  projectId: string,
): Promise<void> {
  const deleted = deleteProject(ctx.db, projectId);
  ctx.realtime.project(projectId, ["project-deleted"]);
  for (const threadId of deleted.threadIds) {
    ctx.realtime.thread(threadId, ["thread-deleted"], { projectId });
  }
  for (const environment of deleted.environments) {
    ctx.realtime.environment(environment.id, ["environment-deleted"]);
  }
  const attachments = projectAttachmentsDir(ctx.config.dataDir, projectId);
  await rm(attachments, { recursive: true, force: true });
  const failed = (err: unknown) =>
    ctx.log.error("Project deletion cleanup failed", { err, projectId });
  void asSystem(() =>
    removeProjectWorkspaces(ctx, deleted)
      .catch(failed)
      .then(() => ctx.emit(projects.deleted, deleted))
      .catch(failed),
  );
}
