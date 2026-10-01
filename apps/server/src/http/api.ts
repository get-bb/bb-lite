import type { HttpBindings } from "@hono/node-server";
import { typedRoutes, type PublicApiSchema } from "@bb/server-contract";
import type { Hono } from "hono";
import type { ServerContext } from "../context.js";
import { invalidRequest } from "./errors.js";

export type AppEnv = { Bindings: HttpBindings };
export type ApiApp = Hono<AppEnv>;
export type RouteGroup = (app: ApiApp, ctx: ServerContext) => void;

export function typedApi(app: ApiApp) {
  return typedRoutes<PublicApiSchema>(app, {
    onValidationError: invalidRequest,
  });
}
