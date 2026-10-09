import { join } from "node:path";
import { plugins, sessions, type PluginServerApi } from "@bb/plugin";
import {
  bindProviderCatalog,
  findProviderDefinition,
  listEnabledProviders,
  listProviderCatalog,
  setProviderEnabled,
} from "@bb/server-kit/providers/catalog";
import { resolveExecutionOptions } from "@bb/server-kit/providers/models";
import { ApiError } from "@bb/server-kit/http/errors";
import { resolveMention, searchMentions } from "./mentions.js";
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
    join(bb.server.cliDir, "skills"),
    ...(await bb.call(plugins.skillDirs, {})),
  ]);
  bb.implement(sessions.searchMentions, (input) => {
    const { trigger, projectId = null, threadId = null } = input;
    const query = input.query.trim();
    return searchMentions(bb, { trigger, query, projectId, threadId });
  });
  bb.implement(sessions.resolveMention, ({ pluginId, itemId }) =>
    resolveMention(bb, pluginId, itemId),
  );
  bb.implement(sessions.title, ({ prompt }, { signal }) =>
    generateTitle(bb, prompt, signal),
  );
  bb.implement(sessions.providers, ({ capability }) => {
    const providers = listEnabledProviders(db).map(({ info }) => info);
    const usageOnly = capability === "usage";
    return providers.filter(
      ({ maintenance }) => !usageOnly || maintenance.usage,
    );
  });
  bb.implement(sessions.providerCatalog, () => listProviderCatalog(db));
  bb.implement(sessions.updateProvider, ({ providerId, enabled }) => {
    if (findProviderDefinition(db, providerId) === undefined) {
      const message = `Unknown provider "${providerId}".`;
      throw new ApiError(404, "provider_not_found", message);
    }
    setProviderEnabled(db, providerId, enabled);
    bb.realtime.system(["config-changed"]);
    return listProviderCatalog(db);
  });
  bb.implement(sessions.executionOptions, (query) =>
    resolveExecutionOptions(bb, query),
  );
}
