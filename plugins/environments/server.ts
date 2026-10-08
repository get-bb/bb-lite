import type { PluginServerApi } from "@bb/plugin";
import { coreOf } from "@bb/server-kit/host";
import { createEnvironments } from "./manager.js";
import { registerEnvironmentRoutes } from "./routes.js";

export default function environments(bb: PluginServerApi): void {
  const { ctx, routes } = coreOf(bb);
  const manager = createEnvironments(ctx, bb);
  ctx.environments = manager;
  routes(registerEnvironmentRoutes);
  bb.onStart(() => manager.start());
}
