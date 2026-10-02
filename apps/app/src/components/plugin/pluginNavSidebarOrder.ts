import { arrangeByStoredOrder } from "@bb/client-core";

interface PluginNavPanelIdentity {
  pluginId: string;
  id: string;
}

export const BUILT_IN_SIDEBAR_NAVIGATION_KEYS = {
  newThread: "__bb__/new-thread",
  searchThreads: "__bb__/search-threads",
  automations: "__bb__/automations",
} as const;

export const DEFAULT_HIDDEN_SIDEBAR_NAVIGATION_KEYS = [
  BUILT_IN_SIDEBAR_NAVIGATION_KEYS.searchThreads,
] as const;

export const DEFAULT_BUILT_IN_SIDEBAR_NAVIGATION_ORDER = [
  BUILT_IN_SIDEBAR_NAVIGATION_KEYS.newThread,
  BUILT_IN_SIDEBAR_NAVIGATION_KEYS.searchThreads,
  BUILT_IN_SIDEBAR_NAVIGATION_KEYS.automations,
] as const;

export function getPluginNavPanelKey(panel: PluginNavPanelIdentity): string {
  return `${panel.pluginId}/${panel.id}`;
}

interface ArrangePluginNavPanelPreferencesArgs<
  TPanel extends PluginNavPanelIdentity,
> {
  panels: readonly TPanel[];
  storedOrder: readonly string[];
  storedVisibleKeys: readonly string[] | null;
  defaultHiddenKeys: readonly string[];
}

interface ArrangedPluginNavPanelPreferences<
  TPanel extends PluginNavPanelIdentity,
> {
  ordered: TPanel[];
  normalizedOrder: string[];
  visible: TPanel[];
  visibleKeys: string[];
  normalizedVisibleKeys: string[] | null;
}

export function arrangePluginNavPanelPreferences<
  TPanel extends PluginNavPanelIdentity,
>({
  panels,
  storedOrder,
  storedVisibleKeys,
  defaultHiddenKeys,
}: ArrangePluginNavPanelPreferencesArgs<TPanel>): ArrangedPluginNavPanelPreferences<TPanel> {
  const { ordered, normalizedOrder } = arrangeByStoredOrder({
    items: panels,
    getId: getPluginNavPanelKey,
    storedOrder,
  });
  const normalizedVisibleKeys =
    storedVisibleKeys === null
      ? null
      : [...new Set(storedVisibleKeys.filter((key) => key.length > 0))];
  const defaultHiddenKeySet = new Set(defaultHiddenKeys);
  const visibleKeys =
    normalizedVisibleKeys ??
    ordered
      .map(getPluginNavPanelKey)
      .filter((key) => !defaultHiddenKeySet.has(key));
  const visibleSet = new Set(visibleKeys);

  return {
    ordered,
    normalizedOrder,
    visible: ordered.filter((panel) =>
      visibleSet.has(getPluginNavPanelKey(panel)),
    ),
    visibleKeys: ordered
      .map(getPluginNavPanelKey)
      .filter((key) => visibleSet.has(key)),
    normalizedVisibleKeys,
  };
}

export function togglePluginNavPanelVisibility(
  visibleKeys: readonly string[],
  key: string,
  visible: boolean,
): string[] {
  const normalized = [
    ...new Set(visibleKeys.filter((item) => item.length > 0)),
  ];
  if (visible) {
    return normalized.includes(key) ? normalized : [...normalized, key];
  }
  return normalized.filter((item) => item !== key);
}
