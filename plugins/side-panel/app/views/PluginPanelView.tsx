import { shell } from "@bb/plugin/app";
import { useOwned } from "@bb/app-kit/plugins/slots";
import { PageShell } from "@bb/app-kit/components/ui/page-shell";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { PluginSlotMount } from "@bb/app-kit/plugins/mount";
import { usePluginsSettled } from "@bb/app-kit/plugins/registry";

export function PluginPanelView({
  pluginId,
  panelPath,
  subPath,
}: {
  pluginId: string;
  panelPath: string;
  subPath: string;
}) {
  const navPanels = useOwned(shell.navPanel);
  const pluginsSettled = usePluginsSettled();
  const panel = navPanels.find(
    (candidate) =>
      candidate.pluginId === pluginId && candidate.path === panelPath,
  );
  if (panel === undefined) {
    return (
      <PageShell contentClassName="pt-[calc(var(--bb-app-chrome-row-height)+1rem)] md:pt-[calc(var(--bb-app-chrome-row-height)+1.25rem)]">
        {pluginsSettled ? (
          <EmptyStatePanel className="rounded-lg p-6 text-sm">
            This plugin panel is not available. The plugin may have been
            disabled or removed.
          </EmptyStatePanel>
        ) : null}
      </PageShell>
    );
  }
  return (
    <div
      className="-m-4 flex min-h-0 flex-1 flex-col overflow-hidden md:-m-5"
      data-testid="plugin-panel-body"
    >
      <PluginSlotMount
        key={`${panel.pluginId}/${panel.id}`}
        pluginId={panel.pluginId}
        slotKind="navPanel"
        slotId={panel.id}
      >
        <panel.view subPath={subPath} />
      </PluginSlotMount>
    </div>
  );
}
