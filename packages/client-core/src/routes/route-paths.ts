import { PERSONAL_PROJECT_ID } from "@bb/domain";

export const APP_ROOT_ROUTE_PATH = "/";
export const SETTINGS_ROUTE_PATH = "/settings";
export const SETTINGS_SECTION_ROUTE_PATH = "/settings/:section";
export const SETTINGS_PLUGINS_ROUTE_PATH = "/settings/plugins";
export const SETTINGS_PLUGIN_ROUTE_PATH = "/settings/plugins/:pluginId";
export const SETTINGS_MACHINE_ROUTE_PATH = "/settings/machines/:hostId";
export const SETTINGS_PROJECT_ROUTE_PATH = "/settings/projects/:projectId";
export const LEGACY_PROJECT_COMPOSE_ROUTE_PATH = "/projects/:projectId";
export const PROJECTLESS_ARCHIVED_ROUTE_PATH = "/archived";
export const PLUGIN_PANEL_ROUTE_PATH = "/plugins/:pluginId/:panelPath/*";

export const ROUTE_PATTERNS: readonly string[] = [
  APP_ROOT_ROUTE_PATH,
  SETTINGS_ROUTE_PATH,
  SETTINGS_SECTION_ROUTE_PATH,
  SETTINGS_PROJECT_ROUTE_PATH,
  SETTINGS_PLUGINS_ROUTE_PATH,
  SETTINGS_PLUGIN_ROUTE_PATH,
  LEGACY_PROJECT_COMPOSE_ROUTE_PATH,
  PROJECTLESS_ARCHIVED_ROUTE_PATH,
  "/threads/:threadId",
  "/projects/:projectId/threads/:threadId",
  PLUGIN_PANEL_ROUTE_PATH,
];

export interface ThreadRoutePathArgs {
  projectId: string;
  threadId: string;
}

export function isProjectlessProjectId(
  projectId: string | null | undefined,
): boolean {
  return projectId === PERSONAL_PROJECT_ID;
}

export function getRootComposeRoutePath(): string {
  return APP_ROOT_ROUTE_PATH;
}

export function getProjectComposeRoutePath(projectId: string): string {
  return isProjectlessProjectId(projectId)
    ? APP_ROOT_ROUTE_PATH
    : `/projects/${projectId}`;
}

export function getSettingsRoutePath(section?: string): string {
  return section === undefined
    ? SETTINGS_ROUTE_PATH
    : `/settings/${encodeURIComponent(section)}`;
}

export function getSettingsMachineRoutePath(hostId: string): string {
  return `/settings/machines/${encodeURIComponent(hostId)}`;
}

export function getSettingsProjectRoutePath(projectId: string): string {
  return `/settings/projects/${encodeURIComponent(projectId)}`;
}

export function getPluginConfigurationRoutePath(args: {
  pluginId: string;
}): string {
  return `/settings/plugins/${encodeURIComponent(args.pluginId)}`;
}

export function getPluginPanelRoutePath(args: {
  pluginId: string;
  path: string;
  subPath?: string;
}): string {
  const subSegments = (args.subPath ?? "")
    .split("/")
    .filter((segment) => segment.length > 0);
  return `/plugins/${[args.pluginId, args.path, ...subSegments]
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

export function getThreadRoutePath(args: ThreadRoutePathArgs): string {
  return isProjectlessProjectId(args.projectId)
    ? `/threads/${args.threadId}`
    : `/projects/${args.projectId}/threads/${args.threadId}`;
}

export function stripRoutePathSuffix(path: string): string {
  return path.split(/[?#]/u)[0] ?? path;
}
