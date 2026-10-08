import { projects, type PluginServerApi } from "@bb/plugin";
import {
  ensurePersonalProject,
  listStandardProjects,
} from "@bb/server-kit/db/projects";
import { coreOf } from "@bb/server-kit/host";
import { registerProjectRoutes } from "./routes.js";

export default function projectsPlugin(bb: PluginServerApi): void {
  const { ctx, routes } = coreOf(bb);
  const { db } = ctx;
  routes(registerProjectRoutes);
  bb.implement(projects.list, () => listStandardProjects(db));
  bb.onStart(() => {
    ensurePersonalProject(db);
  });
}
