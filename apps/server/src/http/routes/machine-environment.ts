import { publicApiRoutes } from "@bb/server-contract";
import type { ServerContext } from "../../context.js";
import {
  machineEnvironmentView,
  projectMachineEnvironmentView,
  replaceMachineEnvironment,
} from "../../machine-environment.js";
import { requireProject } from "../../projects/require.js";
import { typedApi, type ApiApp } from "../api.js";

export function registerMachineEnvironmentRoutes(
  app: ApiApp,
  ctx: ServerContext,
): void {
  const { get, put } = typedApi(app);
  const { system, projects } = publicApiRoutes;
  const { db, hub } = ctx;

  get(system.machineEnvironment, (c) => c.json(machineEnvironmentView(db)));

  put(system.replaceMachineEnvironment, async (c, payload) => {
    await replaceMachineEnvironment(ctx, null, payload);
    hub.system(["config-changed"]);
    return c.json(machineEnvironmentView(db));
  });

  get(projects.machineEnvironment, (c) => {
    const { id } = requireProject(db, c.req.param("id"));
    return c.json(projectMachineEnvironmentView(db, id));
  });

  put(projects.replaceMachineEnvironment, async (c, payload) => {
    const { id } = requireProject(db, c.req.param("id"));
    await replaceMachineEnvironment(ctx, id, payload);
    hub.system(["config-changed"]);
    return c.json(projectMachineEnvironmentView(db, id));
  });
}
