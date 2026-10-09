import { Hono } from "hono";
import {
  DOOR_HEADER,
  server,
  type ApiRoutes,
  type Authenticator,
} from "@bb/plugin";
import { runAs } from "@bb/server-kit/auth/actor";
import type { HostContext } from "../host-context.js";
import { THREAD_ID_HEADER } from "@bb/server-kit/runners/access";
import { declaredDoor, throughDoor } from "@bb/server-kit/kernel/caller";
import type { ApiApp, AppEnv } from "@bb/server-kit/http/api";
import { compressJson } from "./compression.js";
import { registerOpDoors } from "./doors.js";
import { ApiError, errorResponse, notFound } from "@bb/server-kit/http/errors";
import { registerStaticApp } from "./static.js";
import { principals, withRequest } from "@bb/server-kit/http/trust";

export function authenticatorOf(ctx: HostContext): Authenticator {
  const authenticator = ctx.kernel.pick(server.authenticator);
  if (authenticator !== null) return authenticator;
  const message = "No plugin is providing sign-in";
  throw new ApiError(503, "identity_unavailable", message);
}

export class RouteTable {
  private readonly groups = new Set<{ group: ApiRoutes; internal: boolean }>();
  version = 0;

  add(group: ApiRoutes, internal = false): () => void {
    const entry = { group, internal };
    this.groups.add(entry);
    this.version += 1;
    return () => {
      if (this.groups.delete(entry)) this.version += 1;
    };
  }

  of(internal: boolean): ApiRoutes[] {
    const listed = [...this.groups].filter(
      (entry) => entry.internal === internal,
    );
    return listed.map(({ group }) => group);
  }
}

function mount(app: ApiApp, prefix: string, groups: readonly ApiRoutes[]) {
  const scoped = new Hono<AppEnv>();
  for (const register of groups) register(scoped);
  app.route(prefix, scoped);
  app.all(`${prefix}/*`, () => {
    throw notFound();
  });
}

function assemble(ctx: HostContext, table: RouteTable): ApiApp {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => errorResponse(error, ctx.log, c.req));
  app.use("*", async (c, next) => {
    const { origin } = new URL(c.req.url);
    const sender = c.req.header("origin") ?? null;
    const { headers, socket } = c.env.incoming;
    const { method, path } = c.req;
    const request = { method, path, headers, socket };
    const authenticator = authenticatorOf(ctx);
    const principal = authenticator.principal(request);
    principals.set(c.req.raw, principal);
    const threadId = c.req.header(THREAD_ID_HEADER);
    const door = declaredDoor(c.req.header(DOOR_HEADER));
    const actor = authenticator.actor(principal, threadId);
    const machine = principal.kind === "runner";
    const scope = { principal, origin, sender };
    await runAs(actor, () =>
      throughDoor(door, machine, () => withRequest(scope, next)),
    );
  });
  app.use("/api/v1/*", compressJson);
  app.get("/health", (c) => c.json({ ok: true, version: ctx.config.version }));
  const doors: ApiRoutes = (scoped) => registerOpDoors(scoped, ctx.kernel);
  mount(app, "/api/v1", [...table.of(false), doors]);
  mount(app, "/internal", table.of(true));
  registerStaticApp(app, ctx.config.appDir);
  return app;
}

export type HttpApp = Pick<ApiApp, "fetch">;

export function createHttpApp(ctx: HostContext, table: RouteTable): HttpApp {
  let built: { version: string; app: ApiApp } | undefined;
  const current = (): ApiApp => {
    const version = `${table.version}/${ctx.kernel.implementations()}`;
    if (built?.version !== version) {
      built = { version, app: assemble(ctx, table) };
    }
    return built.app;
  };
  return {
    fetch: (...request) => current().fetch(...request),
  };
}
