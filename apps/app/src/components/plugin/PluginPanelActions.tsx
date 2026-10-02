import { useMemo, type ReactNode } from "react";
import type { PluginPanelOpenOptions } from "@bb/plugin/app";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { usePluginSlots, type PluginSlot } from "@/plugins/registry";
import type { PanelTab } from "@/components/secondary-panel/panelTabs";
import {
  parsePersistedPluginPanelParams,
  serializePluginPanelParams,
} from "@/lib/plugin-json-value";
import { PluginSlotMount } from "@/plugins/mount";

export interface OpenPluginPanelArgs {
  pluginId: string;
  actionId: string;
  title: string;
  paramsJson: string | null;
}

type OpenPluginPanelHandler = (args: OpenPluginPanelArgs) => void;
type PluginPanelFixedPanelTab = Extract<PanelTab, { kind: "plugin-panel" }>;

export interface PluginPanelActionEntry {
  id: string;
  pluginId: string;
  icon: string | null;
  title: string;
  onSelect: () => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface PanelActionOpenPanelArgs {
  action: { pluginId: string; id: string; title: string };
  slot: string;
  openPluginPanel: OpenPluginPanelHandler;
}

function createPanelActionOpenPanel({
  action,
  slot,
  openPluginPanel,
}: PanelActionOpenPanelArgs): (options?: PluginPanelOpenOptions) => boolean {
  return (options) => {
    let paramsJson: string | null;
    try {
      paramsJson = serializePluginPanelParams(options?.params);
    } catch (error) {
      console.warn(
        `[plugin:${action.pluginId}] ${slot} "${action.id}" openPanel declined: ${describeError(error)}`,
      );
      return false;
    }
    openPluginPanel({
      pluginId: action.pluginId,
      actionId: action.id,
      title: options?.title ?? action.title,
      paramsJson,
    });
    return true;
  };
}

interface RunPluginPanelActionArgs {
  action: PluginSlot<"threadPanels">;
  openPluginPanel: OpenPluginPanelHandler;
  threadId: string;
}

function runPluginPanelAction({
  action,
  openPluginPanel,
  threadId,
}: RunPluginPanelActionArgs): void {
  const openPanel = createPanelActionOpenPanel({
    action,
    slot: "threadPanelAction",
    openPluginPanel,
  });
  const warn = (error: unknown) => {
    console.warn(
      `[plugin:${action.pluginId}] threadPanelAction "${action.id}" failed: ${describeError(error)}`,
    );
  };
  try {
    if (action.run === undefined) {
      openPanel();
      return;
    }
    const result = action.run({ threadId, openPanel });
    if (result instanceof Promise) result.catch(warn);
  } catch (error) {
    warn(error);
  }
}

export function usePluginPanelActions({
  openPluginPanel,
  threadId,
}: {
  openPluginPanel: OpenPluginPanelHandler;
  threadId: string | null | undefined;
}): readonly PluginPanelActionEntry[] {
  const { threadPanels } = usePluginSlots();
  return useMemo(() => {
    if (threadId === null || threadId === undefined || threadId.length === 0) {
      return [];
    }
    return threadPanels.map((action) => ({
      id: `plugin-action:${action.pluginId}:${action.id}`,
      pluginId: action.pluginId,
      icon: action.icon ?? null,
      title: action.title,
      onSelect: () =>
        runPluginPanelAction({ action, openPluginPanel, threadId }),
    }));
  }, [openPluginPanel, threadId, threadPanels]);
}

type PluginPanelSurfaceContext =
  | { kind: "thread"; threadId: string }
  | { kind: "new-thread" };

export function PluginPanelTabContent({
  tab,
  context,
}: {
  tab: PluginPanelFixedPanelTab;
  context: PluginPanelSurfaceContext;
}) {
  return context.kind === "thread" ? (
    <ThreadActionTabContent tab={tab} threadId={context.threadId} />
  ) : (
    <UnavailableActionTab />
  );
}

function UnavailableActionTab() {
  return (
    <div className="p-4">
      <EmptyStatePanel className="rounded-lg p-6 text-sm">
        This plugin tab is not available. The plugin may still be loading, or it
        has been disabled or removed.
      </EmptyStatePanel>
    </div>
  );
}

function PanelActionTabFrame({
  layout,
  testId,
  children,
}: {
  layout: "padded" | "flush" | undefined;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div
      className={
        layout === "flush"
          ? "h-full min-h-0 flex-1 overflow-hidden"
          : "h-full min-h-0 flex-1 overflow-y-auto p-4"
      }
      data-testid={testId}
    >
      {children}
    </div>
  );
}

function usePersistedActionParams(tab: PluginPanelFixedPanelTab) {
  return useMemo(
    () => parsePersistedPluginPanelParams(tab.paramsJson),
    [tab.paramsJson],
  );
}

function ThreadActionTabContent({
  tab,
  threadId,
}: {
  tab: PluginPanelFixedPanelTab;
  threadId: string;
}) {
  const { threadPanels } = usePluginSlots();
  const action =
    threadPanels.find(
      (candidate) =>
        candidate.pluginId === tab.pluginId && candidate.id === tab.actionId,
    ) ?? null;
  const params = usePersistedActionParams(tab);
  if (action === null) return <UnavailableActionTab />;
  return (
    <PanelActionTabFrame
      layout={action.layout}
      testId="plugin-panel-tab-content"
    >
      <PluginSlotMount
        key={`thread/${action.pluginId}/${action.id}/${action.generation}`}
        pluginId={action.pluginId}
        slotKind="threadPanelAction"
        slotId={action.id}
      >
        <action.component threadId={threadId} params={params} />
      </PluginSlotMount>
    </PanelActionTabFrame>
  );
}
