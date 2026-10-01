import { Hono } from "hono";
import type { ServerContext } from "../context.js";
import { getAppSettings } from "../db/settings.js";
import { findRunnerHost } from "../runners/enrollment.js";
import type { ApiApp, AppEnv } from "./api.js";
import { errorResponse } from "./errors.js";
import { registerRoutes } from "./routes/index.js";
import { registerStaticApp } from "./static.js";
import { authorize, principals, type TrustLookups } from "./trust.js";

export function trustLookups({ db }: ServerContext): TrustLookups {
  return {
    publicUrl: () => getAppSettings(db).machineServerUrl,
    runnerMachine: (token) => findRunnerHost(db, token),
  };
}

export function createHttpApp(ctx: ServerContext): ApiApp {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => errorResponse(error, ctx.log, c.req));
  app.use("*", async (c, next) => {
    const { headers, socket } = c.env.incoming;
    const { method, path } = c.req;
    const request = { method, path, headers, socket };
    principals.set(c.req.raw, authorize(request, trustLookups(ctx)));
    await next();
  });
  app.get("/health", (c) => c.json({ ok: true, version: ctx.config.version }));
  registerRoutes(app, ctx);
  registerStaticApp(app, ctx.config.appDir);
  return app;
}
