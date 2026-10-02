import { Hono } from "hono";
import type { ServerContext } from "../context.js";
import { findRunnerHost } from "../runners/enrollment.js";
import { publicServerUrl } from "../runners/hosts.js";
import type { ApiApp, AppEnv, RouteGroup } from "./api.js";
import { errorResponse, notFound } from "./errors.js";
import { registerEnvironmentRoutes } from "./routes/environments.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerHostRoutes, registerRunnerRoutes } from "./routes/hosts.js";
import { registerPluginRoutes } from "./routes/plugins.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerTerminalRoutes } from "./routes/terminals.js";
import { registerThreadReadRoutes } from "./routes/thread-read.js";
import { registerThreadRoutes } from "./routes/threads.js";
import { registerStaticApp } from "./static.js";
import { authorize, principals, type TrustLookups } from "./trust.js";

const publicApiRouteGroups: RouteGroup[] = [
  registerSettingsRoutes,
  registerProjectRoutes,
  registerHostRoutes,
  registerProviderRoutes,
  registerPluginRoutes,
  registerEnvironmentRoutes,
  registerFileRoutes,
  registerTerminalRoutes,
  registerThreadRoutes,
  registerThreadReadRoutes,
];

export function trustLookups(ctx: ServerContext): TrustLookups {
  return {
    publicUrl: () => publicServerUrl(ctx),
    runnerMachine: (token) => findRunnerHost(ctx.db, token),
  };
}

function mount(
  app: ApiApp,
  prefix: string,
  groups: RouteGroup[],
  ctx: ServerContext,
) {
  const scoped = new Hono<AppEnv>();
  for (const register of groups) register(scoped, ctx);
  app.route(prefix, scoped);
  app.all(`${prefix}/*`, () => {
    throw notFound();
  });
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
  mount(app, "/api/v1", publicApiRouteGroups, ctx);
  mount(app, "/internal", [registerRunnerRoutes], ctx);
  registerStaticApp(app, ctx.config.appDir);
  return app;
}
