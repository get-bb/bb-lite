import { useMemo } from "react";
import type { PluginPanelOpenOptions } from "@bb/plugin/app";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import type { PanelTab } from "../secondary-panel/panelTabs";
import {
  parsePersistedPluginPanelParams,
  serializePluginPanelParams,
} from "@bb/app-kit/lib/plugin-json-value";
import { PluginSlotMount } from "@bb/app-kit/plugins/mount";
import { usePluginSlots, type PluginSlot } from "@bb/app-kit/plugins/registry";

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
  action: PluginSlot<"threadPanels">,
  threadId: string,
  openPluginPanel: (args: OpenPluginPanelArgs) => void,
): void {
  const { pluginId, id, title } = action;
  const warn = (what: string, error: unknown) =>
    console.warn(
      `[plugin:${pluginId}] threadPanel "${id}" ${what}: ${error instanceof Error ? error.message : String(error)}`,
    );
  const openPanel = (options?: PluginPanelOpenOptions) => {
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
  const { threadPanels } = usePluginSlots();
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
  const action = usePluginSlots().threadPanels.find(
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
        key={`thread/${action.pluginId}/${action.id}/${action.generation}`}
        pluginId={action.pluginId}
        slotKind="threadPanelAction"
        slotId={action.id}
      >
        <action.component threadId={context.threadId} params={params} />
      </PluginSlotMount>
    </div>
  );
}
