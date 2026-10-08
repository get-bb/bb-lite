import { Hono } from "hono";
import { DOOR_HEADER } from "@bb/plugin";
import { runAs } from "@bb/server-kit/auth/actor";
import type { ServerContext } from "@bb/server-kit/context";
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
import { registerStaticApp } from "./static.js";
import {
  authorize,
  principals,
  sessionCookieName,
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

export class RouteTable {
  private readonly groups = new Set<{ group: RouteGroup; internal: boolean }>();
  version = 0;

  add(group: RouteGroup, internal = false): () => void {
    const entry = { group, internal };
    this.groups.add(entry);
    this.version += 1;
    return () => {
      if (this.groups.delete(entry)) this.version += 1;
    };
  }

  of(internal: boolean): RouteGroup[] {
    const listed = [...this.groups].filter(
      (entry) => entry.internal === internal,
    );
    return listed.map(({ group }) => group);
  }
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

function assemble(ctx: ServerContext, table: RouteTable): ApiApp {
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
  mount(app, "/api/v1", table.of(false), ctx);
  mount(app, "/internal", table.of(true), ctx);
  registerStaticApp(app, ctx.config.appDir);
  return app;
}

export function createHttpApp(
  ctx: ServerContext,
  table: RouteTable,
): Pick<ApiApp, "fetch"> {
  let built: { version: number; app: ApiApp } | undefined;
  return {
    fetch: (...request) => {
      if (built?.version !== table.version) {
        built = { version: table.version, app: assemble(ctx, table) };
      }
      return built.app.fetch(...request);
    },
  };
}
