import type { PluginServerApi } from "@bb/plugin";
import { publicApiRoutes } from "@bb/server-contract";
import {
  findProviderDefinition,
  listEnabledProviders,
  listProviderCatalog,
  setProviderEnabled,
} from "@bb/server-kit/providers/catalog";
import { resolveExecutionOptions } from "@bb/server-kit/providers/models";
import { typedApi, type ApiApp } from "@bb/server-kit/http/api";
import { ApiError } from "@bb/server-kit/http/errors";

const IMMUTABLE = "public, max-age=31536000, immutable";

export function registerProviderRoutes(app: ApiApp, bb: PluginServerApi): void {
  const { get, put } = typedApi(app);
  const routes = publicApiRoutes.system;
  const { db, realtime: hub } = bb;

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

  get(routes.executionOptions, async (c, query) =>
    c.json(await resolveExecutionOptions(bb, query)),
  );
}
