export interface PluginSettingsCandidate {
  enabled: boolean;
  hasSettings: boolean;
  icon: string | null;
  id: string;
  name: string;
}

export interface PluginSettingsEntry {
  icon: string | null;
  compactIconUrl?: string | null;
  id: string;
  label: string;
}

export function buildPluginSettingsEntries(args: {
  installedPlugins: readonly PluginSettingsCandidate[];
  settingsSections: readonly { pluginId: string }[];
}): PluginSettingsEntry[] {
  return args.installedPlugins
    .filter(
      (plugin) =>
        plugin.enabled &&
        (plugin.hasSettings ||
          args.settingsSections.some(
            (section) => section.pluginId === plugin.id,
          )),
    )
    .map((plugin) => ({
      id: plugin.id,
      label: plugin.name,
      icon: plugin.icon,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}
