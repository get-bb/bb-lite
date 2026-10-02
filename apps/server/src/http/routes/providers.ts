import type { ProviderInfo } from "@bb/domain";
import type { ProviderStatus } from "@bb/runner";
import {
  pluginSettingsUpdateRequestSchema,
  publicApiRoutes,
  type SystemProviderState,
} from "@bb/server-contract";
import type { ServerContext } from "../../context.js";
import {
  findProviderDefinition,
  listEnabledProviders,
  listProviderCatalog,
  setProviderEnabled,
} from "../../providers/catalog.js";
import { listEnvironmentProviders } from "../../providers/environment-providers.js";
import { resolveExecutionOptions } from "../../providers/models.js";
import {
  PROVIDERS_WITH_SETTINGS,
  providerSettingsView,
  updateProviderSettings,
} from "../../providers/settings.js";
import { resolveLookupHostId } from "../../runners/hosts.js";
import { typedApi, type ApiApp } from "../api.js";
import { ApiError, invalidRequest } from "../errors.js";

const UNCHECKED = "Provider readiness could not be checked.";
const IMMUTABLE = "public, max-age=31536000, immutable";

function providerState(
  info: ProviderInfo,
  status: ProviderStatus | undefined,
): SystemProviderState {
  const installed = status?.installed === true;
  return {
    providerId: info.id,
    displayName: info.displayName,
    status:
      status === undefined || installed
        ? (status?.auth ?? "unknown")
        : "not_installed",
    statusMessage: status === undefined ? UNCHECKED : status.message || null,
    accountEmail: null,
    planLabel: null,
    installedVersion: status?.version || null,
    minimumSupportedVersion: null,
    canInstall: false,
    canUpdate: false,
    loginCommand: null,
  };
}

async function listProviderStatuses(ctx: ServerContext, hostId: string) {
  try {
    return await ctx.runners.get(hostId).listProviders();
  } catch (error) {
    ctx.log.debug("Provider readiness check failed", { err: error, hostId });
    return [];
  }
}

export function registerProviderRoutes(app: ApiApp, ctx: ServerContext): void {
  const { get, put } = typedApi(app);
  const routes = publicApiRoutes.system;
  const { db, hub } = ctx;

  get(routes.providers, (c, query) => {
    const providers = listEnabledProviders(db).map(({ info }) => info);
    const usageOnly = query.capability === "usage";
    return c.json(
      providers.filter(({ maintenance }) => !usageOnly || maintenance.usage),
    );
  });

  get(routes.providerCatalog, (c) => c.json(listProviderCatalog(db)));

  put(routes.providerEnabled, (c, payload) => {
    const id = c.req.param("id");
    if (findProviderDefinition(db, id) === undefined) {
      throw new ApiError(
        404,
        "provider_not_found",
        `Unknown provider "${id}".`,
      );
    }
    setProviderEnabled(db, id, payload.enabled);
    hub.system(["config-changed"]);
    return c.json(listProviderCatalog(db));
  });

  get(routes.providerLogo, (c) => {
    const id = c.req.param("id");
    const logo = findProviderDefinition(db, id)?.logo ?? null;
    if (logo === null) {
      throw new ApiError(
        404,
        "provider_logo_not_found",
        `Provider '${id}' has no logo.`,
      );
    }
    const pinned = c.req.query("h") === logo.hash;
    return new Response(new Uint8Array(logo.content), {
      headers: {
        "cache-control": pinned ? IMMUTABLE : "no-cache",
        "content-type": "image/svg+xml",
      },
    });
  });

  get(routes.providerStates, async (c, query) => {
    const hostId = resolveLookupHostId(ctx, query);
    const statuses = await listProviderStatuses(ctx, hostId);
    const providers = listEnabledProviders(db).map(({ id, info }) =>
      providerState(
        info,
        statuses.find((status) => status.providerId === id),
      ),
    );
    return c.json({ providers });
  });

  get(routes.executionOptions, async (c, query) =>
    c.json(await resolveExecutionOptions(ctx, query)),
  );

  get(routes.environmentProviders, async (c, query) =>
    c.json({ providers: await listEnvironmentProviders(ctx, query) }),
  );

  for (const id of PROVIDERS_WITH_SETTINGS) {
    const path = `/plugins/provider-${id}/settings`;
    app.get(path, (c) => c.json(providerSettingsView(db, id)));
    app.put(path, async (c) => {
      const raw: unknown = await c.req.json().catch(() => null);
      const body = pluginSettingsUpdateRequestSchema.safeParse(raw);
      if (!body.success) {
        throw invalidRequest("Expected { values: Record<string, unknown> }");
      }
      updateProviderSettings(db, id, body.data.values);
      hub.system(["config-changed"]);
      return c.json(providerSettingsView(db, id));
    });
  }
}
