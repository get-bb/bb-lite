import { Hono } from "hono";
import type { ServerContext } from "../context.js";
import { getAppSettings } from "../db/settings.js";
import type { ApiApp, AppEnv } from "./api.js";
import { errorResponse } from "./errors.js";
import { registerRoutes } from "./routes/index.js";
import { registerStaticApp } from "./static.js";
import { authorize, principals } from "./trust.js";

export function publicServerUrl(ctx: ServerContext): () => string | null {
  return () => getAppSettings(ctx.db).machineServerUrl;
}

export function createHttpApp(ctx: ServerContext): ApiApp {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => errorResponse(error, ctx.log, c.req));
  app.use("*", async (c, next) => {
    const { headers, socket } = c.env.incoming;
    const { method, path } = c.req;
    const request = { method, path, headers, socket };
    principals.set(c.req.raw, authorize(request, publicServerUrl(ctx)));
    await next();
  });
  app.get("/health", (c) => c.json({ ok: true, version: ctx.config.version }));
  registerRoutes(app, ctx);
  registerStaticApp(app, ctx.config.appDir);
  return app;
}
