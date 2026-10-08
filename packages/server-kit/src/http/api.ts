import type { ApiApp, ApiEnv } from "@bb/plugin";
import { typedRoutes } from "@bb/server-contract";
import type { ServerContext } from "../context.js";
import { invalidRequest } from "./errors.js";

export type AppEnv = ApiEnv;
export type { ApiApp };
export type RouteGroup = (app: ApiApp, ctx: ServerContext) => void;

export function typedApi(app: ApiApp) {
  return typedRoutes(app, { onValidationError: invalidRequest });
}
