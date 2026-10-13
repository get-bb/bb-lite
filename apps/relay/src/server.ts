import startHandler from "@tanstack/react-start/server-entry";
import { OAUTH_AUTHORIZE_PATH } from "@bb/tunnel-contract";
import type * as site from "./site.js";
import { route, scheduled, TunnelDO } from "./worker.js";

export { TunnelDO };

interface Env extends site.Env {
  ASSETS: Fetcher;
}

const READ_METHODS = ["GET", "HEAD"];
const CONSENT_HEADERS = {
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow",
  "cache-control": "no-store",
};

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const answer = await route(request, env, ctx);
    if (answer !== null) return answer;
    if (READ_METHODS.includes(request.method)) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
    }
    const page = await startHandler.fetch(request);
    if (new URL(request.url).pathname !== OAUTH_AUTHORIZE_PATH) return page;
    const guarded = new Response(page.body, page);
    for (const [name, value] of Object.entries(CONSENT_HEADERS)) {
      guarded.headers.set(name, value);
    }
    return guarded;
  },
  scheduled: (_event, env) => scheduled(env),
} satisfies ExportedHandler<Env>;
