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
import { pluginMentionSearchQuerySchema } from "@bb/server-contract";
import { ApiError, invalidRequest } from "@bb/server-kit/http/errors";
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
  bb.implement(sessions.searchMentions, (query) => searchMentions(bb, query));
  bb.implement(sessions.resolveMention, ({ pluginId, itemId }) =>
    resolveMention(bb, pluginId, itemId),
  );
  bb.http.api((app) => {
    app.get("/plugins/mentions/search", async (c) => {
      const parsed = pluginMentionSearchQuerySchema.safeParse(c.req.query());
      if (!parsed.success) throw invalidRequest("Invalid mention search query");
      const { q, trigger, projectId = null, threadId = null } = parsed.data;
      const query = { trigger, query: q.trim(), projectId, threadId };
      return c.json({ ok: true, groups: await searchMentions(bb, query) });
    });
  });
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
