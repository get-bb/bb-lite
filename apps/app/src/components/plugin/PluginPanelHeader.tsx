import { Component, type ReactNode } from "react";
import type { PluginNavPanelChrome } from "@/lib/plugin-nav-panel-chrome";
import type { PluginSlot } from "@/plugins/registry";
import { PluginItemIcon } from "./PluginIcon";
import { PluginContext } from "@/plugins/context";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { getPluginPagePanelStateId } from "./plugin-page-panel-state";

class HeaderContentBoundary extends Component<
  { pluginId: string; children: ReactNode },
  { crashed: boolean }
> {
  override state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  override componentDidCatch(error: Error): void {
    console.warn(
      `[plugin:${this.props.pluginId}] navPanel headerContent crashed and is hidden: ${error.message}`,
    );
  }

  override render(): ReactNode {
    return this.state.crashed ? null : this.props.children;
  }
}

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
  const panelStateId = getPluginPagePanelStateId({
    panelPath: panel.path,
    paneId: paneContext?.paneId,
    pluginId: panel.pluginId,
  });
  return (
    <div className="flex shrink-0 items-center gap-2">
      {HeaderContent === undefined ? null : (
        <HeaderContentBoundary
          key={`${panel.pluginId}/${panel.id}/${panel.generation}`}
          pluginId={panel.pluginId}
        >
          <PluginContext.Provider value={panel.pluginId}>
            <div
              data-bb-plugin={panel.pluginId}
              className="flex shrink-0 items-center gap-2"
            >
              <HeaderContent subPath={subPath} />
            </div>
          </PluginContext.Provider>
        </HeaderContentBoundary>
      )}
      {paneActions}
      <div data-plugin-right-panel-toggle-portal={panelStateId} />
    </div>
  );
}
