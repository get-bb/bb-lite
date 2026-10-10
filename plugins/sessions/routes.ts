import type { PluginServerApi } from "@bb/plugin";
import { findProviderDefinition } from "@bb/server-kit/providers/catalog";
import type { ApiApp } from "@bb/server-kit/http/api";
import { ApiError } from "@bb/server-kit/http/errors";

const IMMUTABLE = "public, max-age=31536000, immutable";

export function registerProviderRoutes(app: ApiApp, bb: PluginServerApi): void {
  app.get("/sessions/providers/:providerId/logo", (c) => {
    const id = c.req.param("providerId");
    const logo = findProviderDefinition(bb.db, id)?.logo ?? null;
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
}
