import { Hono } from "hono";
import type { ServerContext } from "../../context.js";
import type { ApiApp, AppEnv, RouteGroup } from "../api.js";
import { notFound } from "../errors.js";
import { registerSettingsRoutes } from "./settings.js";
import { registerThreadReadRoutes } from "./thread-read.js";
import { registerUiPreferenceRoutes } from "./ui-preferences.js";

const publicApiRouteGroups: RouteGroup[] = [
  registerSettingsRoutes,
  registerUiPreferenceRoutes,
  registerThreadReadRoutes,
];

const internalRouteGroups: RouteGroup[] = [];

function mount(
  app: ApiApp,
  prefix: string,
  groups: RouteGroup[],
  ctx: ServerContext,
): void {
  const scoped = new Hono<AppEnv>();
  for (const register of groups) register(scoped, ctx);
  app.route(prefix, scoped);
  app.all(`${prefix}/*`, () => {
    throw notFound();
  });
}

export function registerRoutes(app: ApiApp, ctx: ServerContext): void {
  mount(app, "/api/v1", publicApiRouteGroups, ctx);
  mount(app, "/internal", internalRouteGroups, ctx);
}
