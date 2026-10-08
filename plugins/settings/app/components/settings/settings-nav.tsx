import { matchPath, useLocation } from "react-router-dom";
import { usePluginList } from "@bb/app-kit/hooks/queries/plugin-settings-queries";
import {
  SETTINGS_MACHINE_ROUTE_PATH,
  SETTINGS_PLUGIN_ROUTE_PATH,
  SETTINGS_PROJECT_ROUTE_PATH,
  SETTINGS_SECTION_ROUTE_PATH,
} from "@bb/app-kit/lib/route-paths";
import {
  usePluginSlots,
  usePluginsSettled,
} from "@bb/app-kit/plugins/registry";
import {
  buildPluginSettingsEntries,
  type PluginSettingsEntry,
} from "@bb/app-kit/components/settings/plugin-settings-entries";
import {
  useSettingsPages,
  type SettingsSectionId,
} from "@bb/app-kit/components/settings/settings-sections";

export function useSettingsNavState(): {
  activeSection: SettingsSectionId | null;
  hasUnknownSection: boolean;
  activePluginId: string | null;
  pluginEntries: readonly PluginSettingsEntry[];
} {
  const { pathname } = useLocation();
  const { settingsSections } = usePluginSlots();
  const pages = useSettingsPages();
  const settled = usePluginsSettled();
  const isPage = (id: string) => pages.some((page) => page.id === id);
  const installedPlugins = usePluginList({ enabled: true }).data?.plugins ?? [];
  const matches = (pattern: string) => matchPath(pattern, pathname) !== null;
  const activePluginId =
    matchPath(SETTINGS_PLUGIN_ROUTE_PATH, pathname)?.params.pluginId ?? null;
  const section = matchPath(SETTINGS_SECTION_ROUTE_PATH, pathname)?.params
    .section;
  return {
    activePluginId,
    hasUnknownSection: section !== undefined && settled && !isPage(section),
    activeSection: matches(SETTINGS_MACHINE_ROUTE_PATH)
      ? "machines"
      : matches(SETTINGS_PROJECT_ROUTE_PATH)
        ? "projects"
        : activePluginId !== null
          ? null
          : section !== undefined && isPage(section)
            ? section
            : "general",
    pluginEntries: buildPluginSettingsEntries({
      installedPlugins,
      settingsSections,
    }),
  };
}
