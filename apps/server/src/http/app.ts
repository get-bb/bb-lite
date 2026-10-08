import { Hono } from "hono";
import { DOOR_HEADER } from "@bb/plugin";
import { runAs } from "@bb/server-kit/auth/actor";
import type { ServerContext } from "@bb/server-kit/context";
import type { CorePlugin } from "../core/plugins.js";
import {
  findExternalUser,
  findSessionUser,
  patchUser,
} from "@bb/server-kit/db/users";
import {
  THREAD_ID_HEADER,
  actorOf,
  ownerUser,
} from "@bb/server-kit/runners/access";
import { declaredDoor, throughDoor } from "@bb/server-kit/kernel/caller";
import { findRunnerHost } from "@bb/server-kit/runners/enrollment";
import { publicServerUrl } from "@bb/server-kit/runners/hosts";
import type { ApiApp, AppEnv, RouteGroup } from "@bb/server-kit/http/api";
import { compressJson } from "./compression.js";
import { errorResponse, notFound } from "@bb/server-kit/http/errors";
import { sessionCookieName } from "./routes/users.js";
import { registerStaticApp } from "./static.js";
import {
  authorize,
  principals,
  type TrustLookups,
} from "@bb/server-kit/http/trust";

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
