import { PERSONAL_PROJECT_ID } from "@bb/domain";

export const APP_ROOT_ROUTE_PATH = "/";
export const SETTINGS_ROUTE_PATH = "/settings";
export const SETTINGS_SECTION_ROUTE_PATH = "/settings/:section";
export const SETTINGS_PLUGINS_ROUTE_PATH = "/settings/plugins";
export const SETTINGS_PLUGIN_ROUTE_PATH = "/settings/plugins/:pluginId";
export const SETTINGS_MACHINE_ROUTE_PATH = "/settings/machines/:hostId";
export const SETTINGS_PROJECT_ROUTE_PATH = "/settings/projects/:projectId";
export const AUTOMATIONS_PLUGIN_ID = "automations";
export const AUTOMATIONS_ROUTE_PATH = "/plugins/automations/automations";
export const AUTOMATIONS_BROWSE_ROUTE_PATH =
  "/plugins/automations/automations/browse";
export const AUTOMATION_DETAIL_ROUTE_PATH =
  "/plugins/automations/automations/:projectId/:automationId";
export const AUTOMATION_EDIT_ROUTE_PATH =
  "/plugins/automations/automations/:projectId/:automationId/edit";
const ROOT_COMPOSE_ROUTE_PATH = APP_ROOT_ROUTE_PATH;
export const LEGACY_PROJECT_COMPOSE_ROUTE_PATH = "/projects/:projectId";
export const PROJECTLESS_ARCHIVED_ROUTE_PATH = "/archived";
const PROJECTLESS_THREAD_DETAIL_ROUTE_PATH = "/threads/:threadId";
const THREAD_DETAIL_ROUTE_PATH = "/projects/:projectId/threads/:threadId";
export const PLUGIN_PANEL_ROUTE_PATH = "/plugins/:pluginId/:panelPath/*";

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
  return ROOT_COMPOSE_ROUTE_PATH;
}

export function getLegacyProjectComposeRoutePath(projectId: string): string {
  return `/projects/${projectId}`;
}

export function getProjectComposeRoutePath(projectId: string): string {
  return isProjectlessProjectId(projectId)
    ? getRootComposeRoutePath()
    : getLegacyProjectComposeRoutePath(projectId);
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

interface PluginDetailRoutePathArgs {
  pluginId: string;
}

export function getPluginConfigurationRoutePath(
  args: PluginDetailRoutePathArgs,
): string {
  return `/settings/plugins/${encodeURIComponent(args.pluginId)}`;
}

interface PluginPanelRoutePathArgs {
  pluginId: string;
  path: string;
  subPath?: string;
}

export function getPluginPanelRoutePath({
  pluginId,
  path,
  subPath,
}: PluginPanelRoutePathArgs): string {
  const root = `/plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(path)}`;
  if (subPath === undefined || subPath === "") {
    return root;
  }
  const encoded = subPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return encoded.length > 0 ? `${root}/${encoded}` : root;
}

export function getThreadRoutePath(args: ThreadRoutePathArgs): string {
  return isProjectlessProjectId(args.projectId)
    ? `/threads/${args.threadId}`
    : `/projects/${args.projectId}/threads/${args.threadId}`;
}

export const ROUTE_PATTERNS: readonly string[] = [
  APP_ROOT_ROUTE_PATH,
  SETTINGS_ROUTE_PATH,
  SETTINGS_SECTION_ROUTE_PATH,
  SETTINGS_PROJECT_ROUTE_PATH,
  SETTINGS_PLUGINS_ROUTE_PATH,
  SETTINGS_PLUGIN_ROUTE_PATH,
  AUTOMATIONS_ROUTE_PATH,
  AUTOMATIONS_BROWSE_ROUTE_PATH,
  AUTOMATION_DETAIL_ROUTE_PATH,
  AUTOMATION_EDIT_ROUTE_PATH,
  LEGACY_PROJECT_COMPOSE_ROUTE_PATH,
  PROJECTLESS_ARCHIVED_ROUTE_PATH,
  PROJECTLESS_THREAD_DETAIL_ROUTE_PATH,
  THREAD_DETAIL_ROUTE_PATH,
  PLUGIN_PANEL_ROUTE_PATH,
];

export function stripRoutePathSuffix(path: string): string {
  const queryIndex = path.indexOf("?");
  const hashIndex = path.indexOf("#");
  const suffixIndex =
    queryIndex === -1
      ? hashIndex
      : hashIndex === -1
        ? queryIndex
        : Math.min(queryIndex, hashIndex);
  return suffixIndex === -1 ? path : path.slice(0, suffixIndex);
}
