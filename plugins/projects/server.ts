import { projects, type PluginServerApi } from "@bb/plugin";
import {
  ensurePersonalProject,
  listStandardProjects,
} from "@bb/server-kit/db/projects";
import { registerProjectRoutes } from "./routes.js";

const PROJECTS_VIEW = `CREATE VIEW p_projects_projects AS
  SELECT id, name, kind, created_at, updated_at
  FROM projects WHERE deleted_at IS NULL`;

export default function projectsPlugin(bb: PluginServerApi): void {
  const { db } = bb;
  bb.http.api((app) => registerProjectRoutes(app, bb));
  bb.storage.tables.migrate([PROJECTS_VIEW]);
  bb.storage.tables.publish(projects.table, "projects");
  bb.implement(projects.list, () => listStandardProjects(db));
  bb.onStart(() => {
    ensurePersonalProject(db);
  });
}
