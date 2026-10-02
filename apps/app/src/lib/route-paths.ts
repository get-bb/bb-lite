import { matchPath } from "react-router-dom";
import {
  PLUGIN_PANEL_ROUTE_PATH,
  ROUTE_PATTERNS,
  stripRoutePathSuffix,
} from "@bb/client-core";

export {
  APP_ROOT_ROUTE_PATH,
  SETTINGS_ROUTE_PATH,
  SETTINGS_SECTION_ROUTE_PATH,
  SETTINGS_PLUGINS_ROUTE_PATH,
  SETTINGS_PLUGIN_ROUTE_PATH,
  SETTINGS_MACHINE_ROUTE_PATH,
  SETTINGS_PROJECT_ROUTE_PATH,
  LEGACY_PROJECT_COMPOSE_ROUTE_PATH,
  PROJECTLESS_ARCHIVED_ROUTE_PATH,
  PLUGIN_PANEL_ROUTE_PATH,
  isProjectlessProjectId,
  getRootComposeRoutePath,
  getProjectComposeRoutePath,
  getSettingsRoutePath,
  getSettingsMachineRoutePath,
  getSettingsProjectRoutePath,
  getPluginConfigurationRoutePath,
  getPluginPanelRoutePath,
  getThreadRoutePath,
} from "@bb/client-core";
export type { ThreadRoutePathArgs } from "@bb/client-core";

export function getPluginPanelRoutePluginId(pathname: string): string | null {
  return matchPath(PLUGIN_PANEL_ROUTE_PATH, pathname)?.params.pluginId ?? null;
}

export function isRoutePath({ path }: { path: string }): boolean {
  const pathname = stripRoutePathSuffix(path);
  return ROUTE_PATTERNS.some(
    (pattern) => matchPath(pattern, pathname) !== null,
  );
}

export function resolveRouteHref(args: {
  currentOrigin: string;
  href: string;
}): { path: string } | null {
  const { currentOrigin, href } = args;
  if (href.startsWith("//") || !/^(\/|https?:\/\/)/iu.test(href)) return null;
  let url: URL;
  try {
    url = new URL(href, currentOrigin);
  } catch {
    return null;
  }
  return url.origin === currentOrigin && isRoutePath({ path: url.pathname })
    ? { path: `${url.pathname}${url.search}${url.hash}` }
    : null;
}
