import { Hono } from "hono";
import { runAs } from "../auth/actor.js";
import type { ServerContext } from "../context.js";
import { findExternalUser, findSessionUser, patchUser } from "../db/users.js";
import { THREAD_ID_HEADER, actorOf, ownerUser } from "../runners/access.js";
import { findRunnerHost } from "../runners/enrollment.js";
import { publicServerUrl } from "../runners/hosts.js";
import type { ApiApp, AppEnv, RouteGroup } from "./api.js";
import { compressJson } from "./compression.js";
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
import { registerUserRoutes, sessionCookieName } from "./routes/users.js";
import { registerStaticApp } from "./static.js";
import { authorize, principals, type TrustLookups } from "./trust.js";

const publicApiRouteGroups: RouteGroup[] = [
  registerUserRoutes,
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
    allowedHosts: ctx.config.allowedHosts,
    sessionCookie: sessionCookieName(ctx.config),
    tunnelToken: ctx.tunnelToken,
    publicUrl: () => publicServerUrl(ctx),
    runnerMachine: (token) => findRunnerHost(ctx.db, token),
    sessionUser: (token) => findSessionUser(ctx.db, token),
    externalUser: (externalId) => findExternalUser(ctx.db, externalId),
    rememberAvatar: (userId, avatarUrl) => {
      patchUser(ctx.db, userId, { avatarUrl });
      ctx.hub.system(["users-changed"]);
    },
    ownerUser: () => ownerUser(ctx.db),
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
    const principal = authorize(request, trustLookups(ctx));
    principals.set(c.req.raw, principal);
    const threadId = c.req.header(THREAD_ID_HEADER);
    await runAs(actorOf(ctx, principal, threadId), next);
  });
  app.use("/api/v1/*", compressJson);
  app.get("/health", (c) => c.json({ ok: true, version: ctx.config.version }));
  mount(app, "/api/v1", publicApiRouteGroups, ctx);
  mount(app, "/internal", [registerRunnerRoutes], ctx);
  registerStaticApp(app, ctx.config.appDir);
  return app;
}
