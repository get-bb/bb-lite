import type { ReactNode } from "react";
import type { PluginNavPanelChrome } from "@bb/app-kit/lib/plugin-nav-panel-chrome";
import { PluginSlotMount } from "@bb/app-kit/plugins/mount";
import type { PluginSlot } from "@bb/app-kit/plugins/registry";
import { useOptionalPaneContext } from "@bb/app-kit/views/thread-detail/PaneContext";
import { PluginItemIcon } from "@bb/app-kit/components/plugin/PluginIcon";
import { getPluginPagePanelStateId } from "./plugin-page-panel-state";

export function PluginPanelHeaderCenter({
  chrome,
}: {
  chrome: Pick<PluginNavPanelChrome, "pluginId" | "icon" | "title">;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <PluginItemIcon
        pluginId={chrome.pluginId}
        icon={chrome.icon}
        className="text-muted-foreground"
      />
      <p className="truncate text-sm font-semibold">{chrome.title}</p>
    </div>
  );
}

export function PluginPanelHeaderActions({
  panel,
  subPath,
  paneActions,
}: {
  panel: PluginSlot<"navPanels">;
  subPath: string;
  paneActions?: ReactNode;
}) {
  const paneContext = useOptionalPaneContext();
  const HeaderContent = panel.headerContent;
  return (
    <div className="flex shrink-0 items-center gap-2">
      {HeaderContent === undefined ? null : (
        <PluginSlotMount
          key={`${panel.pluginId}/${panel.id}/${panel.generation}`}
          pluginId={panel.pluginId}
          slotKind="navPanelHeader"
          slotId={panel.id}
          crashFallback={null}
        >
          <div className="flex shrink-0 items-center gap-2">
            <HeaderContent subPath={subPath} />
          </div>
        </PluginSlotMount>
      )}
      {paneActions}
      <div
        data-plugin-right-panel-toggle-portal={getPluginPagePanelStateId({
          panelPath: panel.path,
          paneId: paneContext?.paneId,
          pluginId: panel.pluginId,
        })}
      />
    </div>
  );
}
