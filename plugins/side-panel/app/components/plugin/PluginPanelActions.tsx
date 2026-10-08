import { sidePanel, type SidePanelPanel } from "@bb/plugin/app";
import { useOwned } from "@bb/app-kit/plugins/slots";
import { useMemo } from "react";
import type { PanelOpenOptions } from "@bb/plugin/app";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import type { PanelTab } from "../secondary-panel/panelTabs";
import {
  parsePersistedPluginPanelParams,
  serializePluginPanelParams,
} from "../../lib/plugin-json-value";
import { PluginSlotMount } from "@bb/app-kit/plugins/mount";
import type { Owned } from "@bb/app-kit/plugins/registry";

export interface OpenPluginPanelArgs {
  pluginId: string;
  actionId: string;
  title: string;
  paramsJson: string | null;
}

type PluginPanelFixedPanelTab = Extract<PanelTab, { kind: "plugin-panel" }>;

export interface PluginPanelActionEntry {
  id: string;
  pluginId: string;
  icon: string | null;
  title: string;
  onSelect: () => void;
}

function runPanelAction(
  action: Owned<SidePanelPanel>,
  threadId: string,
  openPluginPanel: (args: OpenPluginPanelArgs) => void,
): void {
  const { pluginId, id, title } = action;
  const warn = (what: string, error: unknown) =>
    console.warn(
      `[plugin:${pluginId}] threadPanel "${id}" ${what}: ${error instanceof Error ? error.message : String(error)}`,
    );
  const openPanel = (options?: PanelOpenOptions) => {
    try {
      const paramsJson = serializePluginPanelParams(options?.params);
      const panelTitle = options?.title ?? title;
      openPluginPanel({
        pluginId,
        actionId: id,
        title: panelTitle,
        paramsJson,
      });
      return true;
    } catch (error) {
      warn("openPanel declined", error);
      return false;
    }
  };
  try {
    if (action.run === undefined) openPanel();
    else
      void Promise.resolve(action.run({ threadId, openPanel })).catch(
        (error: unknown) => warn("failed", error),
      );
  } catch (error) {
    warn("failed", error);
  }
}

export function usePluginPanelActions({
  openPluginPanel,
  threadId,
}: {
  openPluginPanel: (args: OpenPluginPanelArgs) => void;
  threadId: string | null | undefined;
}): readonly PluginPanelActionEntry[] {
  const threadPanels = useOwned(sidePanel.panel);
  return useMemo(
    () =>
      threadPanels.flatMap((action) =>
        threadId
          ? {
              id: `plugin-action:${action.pluginId}:${action.id}`,
              pluginId: action.pluginId,
              icon: action.icon ?? null,
              title: action.title,
              onSelect: () => runPanelAction(action, threadId, openPluginPanel),
            }
          : [],
      ),
    [openPluginPanel, threadId, threadPanels],
  );
}

export function PluginPanelTabContent({
  tab,
  context,
}: {
  tab: PluginPanelFixedPanelTab;
  context: { kind: "thread"; threadId: string } | { kind: "new-thread" };
}) {
  const action = useOwned(sidePanel.panel).find(
    (candidate) =>
      candidate.pluginId === tab.pluginId && candidate.id === tab.actionId,
  );
  const params = useMemo(
    () => parsePersistedPluginPanelParams(tab.paramsJson),
    [tab.paramsJson],
  );
  if (context.kind !== "thread" || action === undefined) {
    return (
      <div className="p-4">
        <EmptyStatePanel className="rounded-lg p-6 text-sm">
          This plugin tab is not available. The plugin may still be loading, or
          it has been disabled or removed.
        </EmptyStatePanel>
      </div>
    );
  }
  return (
    <div
      className={
        action.layout === "flush"
          ? "h-full min-h-0 flex-1 overflow-hidden"
          : "h-full min-h-0 flex-1 overflow-y-auto p-4"
      }
      data-testid="plugin-panel-tab-content"
    >
      <PluginSlotMount
        key={`thread/${action.pluginId}/${action.id}`}
        pluginId={action.pluginId}
        slotKind="threadPanelAction"
        slotId={action.id}
      >
        <action.view threadId={context.threadId} params={params} />
      </PluginSlotMount>
    </div>
  );
}
