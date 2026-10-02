import { matchPath, useLocation } from "react-router-dom";
import { usePluginList } from "@/hooks/queries/plugin-settings-queries";
import { useSystemProviderCatalog } from "@/hooks/queries/system-queries";
import {
  SETTINGS_MACHINE_ROUTE_PATH,
  SETTINGS_PLUGIN_ROUTE_PATH,
  SETTINGS_PROJECT_ROUTE_PATH,
  SETTINGS_SECTION_ROUTE_PATH,
} from "@/lib/route-paths";
import { usePluginSlots } from "@/plugins/registry";
import {
  buildPluginSettingsEntries,
  type PluginSettingsEntry,
} from "./plugin-settings-entries";
import {
  isSettingsSectionId,
  type SettingsSectionId,
} from "./settings-sections";

const PROVIDERS_WITH_SETTINGS = ["codex", "claude-code"];

export function useSettingsNavState(): {
  activeSection: SettingsSectionId | null;
  hasUnknownSection: boolean;
  activePluginId: string | null;
  pluginEntries: readonly PluginSettingsEntry[];
} {
  const { pathname } = useLocation();
  const { settingsSections } = usePluginSlots();
  const installedPlugins = usePluginList({ enabled: true }).data?.plugins ?? [];
  const providers = useSystemProviderCatalog().data ?? [];
  const matches = (pattern: string) => matchPath(pattern, pathname) !== null;
  const activePluginId =
    matchPath(SETTINGS_PLUGIN_ROUTE_PATH, pathname)?.params.pluginId ?? null;
  const section = matchPath(SETTINGS_SECTION_ROUTE_PATH, pathname)?.params
    .section;
  return {
    activePluginId,
    hasUnknownSection: section !== undefined && !isSettingsSectionId(section),
    activeSection: matches(SETTINGS_MACHINE_ROUTE_PATH)
      ? "machines"
      : matches(SETTINGS_PROJECT_ROUTE_PATH)
        ? "projects"
        : activePluginId !== null
          ? null
          : section !== undefined && isSettingsSectionId(section)
            ? section
            : "general",
    pluginEntries: [
      ...buildPluginSettingsEntries({ installedPlugins, settingsSections }),
      ...providers
        .filter(
          (provider) =>
            provider.enabled && PROVIDERS_WITH_SETTINGS.includes(provider.id),
        )
        .map((provider) => ({
          id: provider.pluginId,
          label: provider.pluginName,
          icon: null,
          compactIconUrl: provider.logoUrl,
        })),
    ].sort((left, right) => left.label.localeCompare(right.label)),
  };
}
