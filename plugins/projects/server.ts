import { projects, type PluginServerApi } from "@bb/plugin";
import {
  ensurePersonalProject,
  listStandardProjects,
} from "@bb/server-kit/db/projects";
import { coreOf } from "@bb/server-kit/host";
import { registerProjectRoutes } from "./routes.js";

const PROJECTS_VIEW = `CREATE VIEW p_projects_projects AS
  SELECT id, name, kind, created_at, updated_at
  FROM projects WHERE deleted_at IS NULL`;

export default function projectsPlugin(bb: PluginServerApi): void {
  const { ctx, routes } = coreOf(bb);
  const { db } = ctx;
  routes(registerProjectRoutes);
  bb.storage.tables.migrate([PROJECTS_VIEW]);
  bb.storage.tables.publish(projects.table, "projects");
  bb.implement(projects.list, () => listStandardProjects(db));
  bb.onStart(() => {
    ensurePersonalProject(db);
  });
}
