import { sessions, type PluginServerApi } from "@bb/plugin";
import { doorInstructions } from "@bb/server-kit/doors";
import { coreOf } from "@bb/server-kit/host";
import {
  bindProviderCatalog,
  listEnabledProviders,
} from "@bb/server-kit/providers/catalog";
import { resolveExecutionOptions } from "@bb/server-kit/providers/models";
import { registerProviderRoutes } from "./routes.js";

export default function sessionsPlugin(bb: PluginServerApi): void {
  const { ctx, routes } = coreOf(bb);
  const { db, kernel } = ctx;
  bindProviderCatalog(db, kernel);
  routes(registerProviderRoutes);
  bb.implement(sessions.instructions, (context) =>
    doorInstructions(kernel, context),
  );
  bb.implement(sessions.env, () => []);
  bb.implement(sessions.providers, () =>
    listEnabledProviders(db).map(({ info }) => info),
  );
  bb.implement(sessions.executionOptions, (query) =>
    resolveExecutionOptions(ctx, query),
  );
}
