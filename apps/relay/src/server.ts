import startHandler from "@tanstack/react-start/server-entry";
import type * as site from "./site.js";
import { route, scheduled, TunnelDO } from "./worker.js";

export { TunnelDO };

interface Env extends site.Env {
  ASSETS: Fetcher;
}

const READ_METHODS = ["GET", "HEAD"];

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const answer = await route(request, env, ctx);
    if (answer !== null) return answer;
    if (READ_METHODS.includes(request.method)) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
    }
    return startHandler.fetch(request);
  },
  scheduled: (_event, env) => scheduled(env),
} satisfies ExportedHandler<Env>;
