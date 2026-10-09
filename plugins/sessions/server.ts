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
import { resolveLookupHostId } from "@bb/server-kit/runners/hosts";
import { pickTranscriber } from "@bb/server-kit/providers/inference";
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
  bb.implement(sessions.transcribe, async (audio, { signal }) => {
    const transcriber = await pickTranscriber(bb);
    if (transcriber === null) {
      const message = "No voice transcription service is available.";
      throw new ApiError(501, "not_configured", message);
    }
    const data = Buffer.from(audio.data, "base64");
    const { mimeType } = audio;
    const { text } = await transcriber.transcribe(
      { data, mimeType },
      { signal },
    );
    return { text };
  });
  bb.implement(sessions.providers, ({ capability }) => {
    const providers = listEnabledProviders(db).map(({ info }) => info);
    const usageOnly = capability === "usage";
    return providers.filter(
      ({ maintenance }) => !usageOnly || maintenance.usage,
    );
  });
  bb.implement(sessions.providerStatus, async ({ hostId }) => {
    const enabled = new Set(
      listEnabledProviders(db).map(({ info }) => info.id),
    );
    const runner = bb.runners.get(resolveLookupHostId(bb, { hostId }));
    const statuses = await runner.listProviders();
    return statuses
      .filter(({ providerId }) => enabled.has(providerId))
      .map((status) => ({
        providerId: status.providerId,
        state: !status.installed
          ? ("not_installed" as const)
          : status.versionUnsupported === true
            ? ("update_required" as const)
            : status.auth === "unauthenticated"
              ? ("needs_login" as const)
              : status.auth === "ready"
                ? ("ready" as const)
                : ("unknown" as const),
        message: status.message,
        ...(status.version === null ? {} : { version: status.version }),
        ...(status.minimumVersion === undefined
          ? {}
          : { minimumVersion: status.minimumVersion }),
        ...(status.versionUnsupported === undefined
          ? {}
          : { versionUnsupported: status.versionUnsupported }),
        ...(status.installAction === undefined
          ? {}
          : { installAction: status.installAction }),
      }));
  });
  bb.implement(sessions.environmentHealth, (input) => {
    const { providerId } = input;
    const machineId = input.machineId ?? bb.runners.localHostId;
    const enabled = listEnabledProviders(db).some(
      ({ info }) => info.id === providerId,
    );
    const status = !enabled
      ? findProviderDefinition(db, providerId) === undefined
        ? "unknown-provider"
        : "disabled"
      : bb.runners.isConnected(machineId)
        ? "ready"
        : "offline";
    return { providerId, machineId, status, label: null, statusMessage: null };
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
