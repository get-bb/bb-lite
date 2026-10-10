import { projects, type PluginServerApi } from "@bb/plugin";
import { rm } from "node:fs/promises";
import { asSystem } from "@bb/server-kit/auth/actor";
import { deleteProject } from "@bb/server-kit/db/projects";
import { removeProjectWorkspaces } from "@bb/server-kit/environments/workspace";
import { projectAttachmentsDir } from "@bb/server-kit/projects/attachments";

export async function removeProject(
  bb: PluginServerApi,
  projectId: string,
): Promise<void> {
  const deleted = deleteProject(bb.db, projectId);
  bb.realtime.project(projectId, ["project-deleted"]);
  for (const threadId of deleted.threadIds) {
    bb.realtime.thread(threadId, ["thread-deleted"], { projectId });
  }
  for (const environment of deleted.environments) {
    bb.realtime.environment(environment.id, ["environment-deleted"]);
  }
  const attachments = projectAttachmentsDir(bb.server.dataDir, projectId);
  await rm(attachments, { recursive: true, force: true });
  const failed = (err: unknown) =>
    bb.log.error("Project deletion cleanup failed", { err, projectId });
  void asSystem(() =>
    removeProjectWorkspaces(bb, deleted)
      .catch(failed)
      .then(() => bb.emit(projects.deleted, deleted))
      .catch(failed),
  );
}
