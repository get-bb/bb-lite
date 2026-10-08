import { environments as contract, type PluginServerApi } from "@bb/plugin";
import {
  getEnvironment,
  listEnvironments,
} from "@bb/server-kit/db/environments";
import { coreOf } from "@bb/server-kit/host";
import { createEnvironments } from "./manager.js";
import { registerEnvironmentRoutes } from "./routes.js";

export default function environments(bb: PluginServerApi): void {
  const { ctx, routes } = coreOf(bb);
  const manager = createEnvironments(ctx, bb);
  ctx.environments = manager;
  routes(registerEnvironmentRoutes);
  bb.implement(contract.get, ({ environmentId }) => {
    return getEnvironment(ctx.db, environmentId) ?? null;
  });
  bb.implement(contract.list, (filter) => listEnvironments(ctx.db, filter));
  bb.onStart(() => manager.start());
}
