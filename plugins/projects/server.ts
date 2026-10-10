import { projects, type PluginServerApi } from "@bb/plugin";
import { ensurePersonalProject } from "@bb/server-kit/db/projects";
import { implementProjects, registerAttachmentRoutes } from "./ops.js";

const PROJECTS_VIEW = `CREATE VIEW p_projects_projects AS
  SELECT id, name, kind, created_at, updated_at
  FROM projects WHERE deleted_at IS NULL`;

export default function projectsPlugin(bb: PluginServerApi): void {
  const { db } = bb;
  bb.http.api((app) => registerAttachmentRoutes(app, bb));
  implementProjects(bb);
  bb.storage.tables.migrate([PROJECTS_VIEW]);
  bb.storage.tables.publish(projects.table, "projects");
  bb.onStart(() => {
    ensurePersonalProject(db);
  });
}
