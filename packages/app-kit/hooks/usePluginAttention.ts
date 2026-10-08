import type { PluginListItem } from "./queries/plugin-settings-queries";

function pluginNeedsAttention(
  plugin: Pick<PluginListItem, "enabled" | "status">,
): boolean {
  return plugin.enabled && plugin.status === "error";
}

export function pluginsNeedingAttention(
  plugins: readonly PluginListItem[],
): PluginListItem[] {
  return plugins.filter(pluginNeedsAttention);
}

export function pluginAttentionLabel(
  plugins: readonly PluginListItem[],
): string {
  if (plugins.length !== 1) return `${plugins.length} plugins are not running`;
  const [plugin] = plugins;
  const detail = plugin.statusDetail ?? "";
  return detail.length > 0 && detail.length <= 80
    ? `${plugin.name} is not running: ${detail}`
    : `${plugin.name} is not running`;
}
