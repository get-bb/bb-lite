import { join } from "node:path";
import { plugins, sessions, type PluginServerApi } from "@bb/plugin";
import {
  bindProviderCatalog,
  listEnabledProviders,
} from "@bb/server-kit/providers/catalog";
import { resolveExecutionOptions } from "@bb/server-kit/providers/models";
import { registerProviderRoutes } from "./routes.js";
import { generateTitle } from "./title.js";

export default function sessionsPlugin(bb: PluginServerApi): void {
  const { db } = bb;
  bindProviderCatalog(db, bb);
  bb.http.api((app) => registerProviderRoutes(app, bb));
  bb.implement(sessions.instructions, (context) =>
    bb.call(plugins.agentInstructions, context),
  );
  bb.implement(sessions.env, () => []);
  bb.implement(sessions.tools, (context) =>
    bb.call(plugins.agentTools, context),
  );
  bb.implement(sessions.skillDirs, async () => [
    join(bb.config.cliDir, "skills"),
    ...(await bb.call(plugins.skillDirs, {})),
  ]);
  bb.implement(sessions.title, ({ prompt }, { signal }) =>
    generateTitle(bb, prompt, signal),
  );
  bb.implement(sessions.providers, () =>
    listEnabledProviders(db).map(({ info }) => info),
  );
  bb.implement(sessions.executionOptions, (query) =>
    resolveExecutionOptions(bb, query),
  );
}
