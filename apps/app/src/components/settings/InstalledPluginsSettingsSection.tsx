import { Link } from "react-router-dom";
import { Switch } from "@bb/shared-ui/switch";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import { usePluginEnabledMutation } from "@/components/plugin/usePluginEnabledMutation";
import {
  SettingsRow,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section.js";
import {
  usePluginList,
  type PluginListItem,
} from "@/hooks/queries/plugin-settings-queries";
import { getPluginConfigurationRoutePath } from "@/lib/route-paths";

function InstalledPluginRow({ plugin }: { plugin: PluginListItem }) {
  const { toggle, enabled } = usePluginEnabledMutation(plugin);
  return (
    <SettingsRow data-testid={`plugin-row-${plugin.id}`}>
      <PluginIcon
        pluginId={plugin.id}
        icon={plugin.icon}
        compactIconUrl={plugin.compactIconUrl}
        className="size-4 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <Link
          to={getPluginConfigurationRoutePath({ pluginId: plugin.id })}
          className="block truncate text-foreground underline-offset-2 hover:underline"
        >
          {plugin.name ?? plugin.id}
        </Link>
        {plugin.description ? (
          <p className="truncate text-xs text-subtle-foreground">
            {plugin.description}
          </p>
        ) : null}
      </div>
      <Switch
        checked={enabled}
        disabled={toggle.isPending}
        onCheckedChange={(next) => toggle.mutate(next)}
        aria-label={`${enabled ? "Disable" : "Enable"} ${plugin.id}`}
      />
    </SettingsRow>
  );
}

export function InstalledPluginsSettingsSection() {
  const listQuery = usePluginList({ enabled: true });
  const plugins = [...(listQuery.data?.plugins ?? [])].sort(
    (left, right) =>
      (left.name ?? left.id).localeCompare(right.name ?? right.id) ||
      left.id.localeCompare(right.id),
  );
  return (
    <SettingsSection title="Installed plugins">
      {listQuery.data === undefined ? (
        <p className="text-sm text-muted-foreground" role="status">
          {listQuery.isError ? "Couldn't load plugins." : "Loading plugins"}
        </p>
      ) : plugins.length === 0 ? (
        <p className="text-sm text-muted-foreground">No plugins installed.</p>
      ) : (
        <SettingsRowList>
          {plugins.map((plugin) => (
            <InstalledPluginRow key={plugin.id} plugin={plugin} />
          ))}
        </SettingsRowList>
      )}
    </SettingsSection>
  );
}
