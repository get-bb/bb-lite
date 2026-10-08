import { Hono } from "hono";
import {
  DOOR_HEADER,
  server,
  type ApiRoutes,
  type Authenticator,
  type Caller,
} from "@bb/plugin";
import { currentActor, runAs, type Actor } from "@bb/server-kit/auth/actor";
import type { HostContext } from "../host-context.js";
import { THREAD_ID_HEADER } from "@bb/server-kit/runners/access";
import {
  currentCaller,
  declaredDoor,
  enterCaller,
  throughDoor,
} from "@bb/server-kit/kernel/caller";
import type { ApiApp, AppEnv } from "@bb/server-kit/http/api";
import { compressJson } from "./compression.js";
import { ApiError, errorResponse, notFound } from "@bb/server-kit/http/errors";
import { registerStaticApp } from "./static.js";
import { principals, type Principal } from "@bb/server-kit/http/trust";

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

interface InnerCall {
  principal: Principal;
  actor: Actor | null;
  caller: Caller;
}

const innerCalls = new WeakMap<Request, InnerCall>();

function identityOf({ userId, role }: Actor) {
  return { userId, role };
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
    const inner = innerCalls.get(c.req.raw);
    if (inner !== undefined) {
      principals.set(c.req.raw, inner.principal);
      await runAs(inner.actor, () => enterCaller(inner.caller, next));
      return;
    }
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
    await runAs(actor, () => throughDoor(door, machine, next));
  });
  app.use("/api/v1/*", compressJson);
  app.get("/health", (c) => c.json({ ok: true, version: ctx.config.version }));
  mount(app, "/api/v1", table.of(false));
  mount(app, "/internal", table.of(true));
  registerStaticApp(app, ctx.config.appDir);
  return app;
}

export interface HttpApp extends Pick<ApiApp, "fetch"> {
  inner(request: Request): Promise<Response>;
}

export function createHttpApp(ctx: HostContext, table: RouteTable): HttpApp {
  let built: { version: number; app: ApiApp } | undefined;
  const current = (): ApiApp => {
    if (built?.version !== table.version) {
      built = { version: table.version, app: assemble(ctx, table) };
    }
    return built.app;
  };
  return {
    fetch: (...request) => current().fetch(...request),
    async inner(request) {
      const actor = currentActor();
      const principal: Principal =
        actor === null
          ? authenticatorOf(ctx).owner()
          : { kind: "user", ...identityOf(actor), implicit: false };
      innerCalls.set(request, { principal, actor, caller: currentCaller() });
      return current().fetch(request);
    },
  };
}
