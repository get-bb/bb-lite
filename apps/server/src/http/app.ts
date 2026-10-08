import { Hono } from "hono";
import { DOOR_HEADER } from "@bb/plugin";
import { runAs } from "../auth/actor.js";
import type { ServerContext } from "../context.js";
import type { CorePlugin } from "../core/plugins.js";
import { findExternalUser, findSessionUser, patchUser } from "../db/users.js";
import { THREAD_ID_HEADER, actorOf, ownerUser } from "../runners/access.js";
import { declaredDoor, throughDoor } from "../kernel/caller.js";
import { findRunnerHost } from "../runners/enrollment.js";
import { publicServerUrl } from "../runners/hosts.js";
import type { ApiApp, AppEnv, RouteGroup } from "./api.js";
import { compressJson } from "./compression.js";
import { errorResponse, notFound } from "./errors.js";
import { sessionCookieName } from "./routes/users.js";
import { registerStaticApp } from "./static.js";
import { authorize, principals, type TrustLookups } from "./trust.js";

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
  groups: readonly RouteGroup[],
  ctx: ServerContext,
) {
  const scoped = new Hono<AppEnv>();
  for (const register of groups) register(scoped, ctx);
  app.route(prefix, scoped);
  app.all(`${prefix}/*`, () => {
    throw notFound();
  });
}

export function createHttpApp(
  ctx: ServerContext,
  core: readonly CorePlugin[],
): ApiApp {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => errorResponse(error, ctx.log, c.req));
  app.use("*", async (c, next) => {
    const { headers, socket } = c.env.incoming;
    const { method, path } = c.req;
    const request = { method, path, headers, socket };
    const principal = authorize(request, trustLookups(ctx));
    principals.set(c.req.raw, principal);
    const threadId = c.req.header(THREAD_ID_HEADER);
    const door = declaredDoor(c.req.header(DOOR_HEADER));
    const actor = actorOf(ctx, principal, threadId);
    const machine = principal.kind === "runner";
    await runAs(actor, () => throughDoor(door, machine, next));
  });
  app.use("/api/v1/*", compressJson);
  app.get("/health", (c) => c.json({ ok: true, version: ctx.config.version }));
  const routes = core.flatMap((plugin) => plugin.routes ?? []);
  const internal = core.flatMap((plugin) => plugin.internalRoutes ?? []);
  mount(app, "/api/v1", routes, ctx);
  mount(app, "/internal", internal, ctx);
  registerStaticApp(app, ctx.config.appDir);
  return app;
}
