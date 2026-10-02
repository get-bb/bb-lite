import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@bb/shared-ui/button";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { COARSE_POINTER_HEADER_ICON_BUTTON_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { cn } from "@bb/shared-ui/lib/utils";
import { Icon } from "@bb/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { PluginItemIcon } from "@/components/plugin/PluginIcon";
import { PluginSlotMount } from "@/plugins/mount";
import { RIGHT_PANEL_TOGGLE_ICON_NAME } from "@/components/secondary-panel/panelToggleControlState";
import { PANEL_SCROLL_SLOT_CLASS } from "@/components/secondary-panel/panelChromeClasses";
import {
  panelTabId,
  usePanelTabs,
} from "@/components/secondary-panel/panelTabs";
import { SecondaryPanelLayout } from "@/components/secondary-panel/SecondaryPanelLayout";
import {
  ThreadSecondaryPanel,
  type SecondaryPanelFixedTab,
} from "@/components/secondary-panel/ThreadSecondaryPanel";
import { usePluginSlots } from "@/plugins/registry";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { getPluginPagePanelStateId } from "./plugin-page-panel-state";

const NO_TABS: never[] = [];

export function PluginPanelRightPanelHost({
  children,
  panelPath,
  pluginId,
  subPath,
  flushPageInsets = false,
}: {
  children: ReactNode;
  panelPath: string;
  pluginId: string;
  subPath: string;
  flushPageInsets?: boolean;
}) {
  const { navPanels } = usePluginSlots();
  const panel =
    navPanels.find(
      (candidate) =>
        candidate.pluginId === pluginId && candidate.path === panelPath,
    ) ?? null;
  const paneContext = useOptionalPaneContext();
  const isFocused = paneContext?.isFocused ?? true;
  const paneId = paneContext?.paneId;
  const panelHostId = paneId ?? "standalone";
  const panelStateId = getPluginPagePanelStateId({
    panelPath,
    paneId,
    pluginId,
  });
  const fixedTabIds = (panel?.fixedTabs ?? []).map((fixedTab) =>
    panelTabId(
      "plugin-page-fixed",
      `${pluginId}:${panel?.id ?? panelPath}:${fixedTab.id}`,
    ),
  );
  const tabs = usePanelTabs({
    panelId: panelStateId,
    fixedIds: fixedTabIds,
    ready: panel !== null,
    defaultOpen: true,
  });
  const isOpen = panel !== null && tabs.isOpen;
  const togglePanel = () => tabs.setOpen(!isOpen);
  const closePanel = () => tabs.setOpen(false);
  useAppCommandHandler("panel.toggle", () => {
    if (!isFocused || panel === null) return false;
    togglePanel();
    return true;
  });

  const [togglePortalTarget, setTogglePortalTarget] =
    useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setTogglePortalTarget(
      Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-plugin-right-panel-toggle-portal]",
        ),
      ).find(
        (candidate) =>
          candidate.getAttribute("data-plugin-right-panel-toggle-portal") ===
          panelStateId,
      ) ?? null,
    );
  }, [panel, panelStateId]);

  const fixedTabs = (panel?.fixedTabs ?? []).map(
    (registration, index): SecondaryPanelFixedTab => {
      const FixedTabComponent = registration.component;
      const id = fixedTabIds[index] ?? registration.id;
      return {
        ariaLabel: registration.title,
        label: registration.title,
        leadingVisual: (
          <PluginItemIcon
            pluginId={pluginId}
            icon={registration.icon}
            className="size-3.5"
          />
        ),
        onSelect: () => tabs.activate(id),
        tab: { id },
        title: registration.title,
        content: (
          <div
            className={
              registration.layout === "flush"
                ? "flex min-h-0 flex-1 flex-col overflow-hidden"
                : cn(PANEL_SCROLL_SLOT_CLASS, "p-4 pb-3")
            }
          >
            {isOpen && panel !== null ? (
              <PluginSlotMount
                key={`${pluginId}/${panel.id}/${registration.id}/${panel.generation}`}
                pluginId={pluginId}
                slotKind="navPanelFixedTab"
                slotId={registration.id}
                instanceId={panel.id}
              >
                <FixedTabComponent subPath={subPath} />
              </PluginSlotMount>
            ) : null}
          </div>
        ),
      };
    },
  );
  const toggleLabel = isOpen ? "Hide right panel" : "Show right panel";

  return (
    <>
      {panel !== null &&
      togglePortalTarget !== null &&
      !isOpen &&
      paneContext?.secondaryPanelHost == null
        ? createPortal(
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={`${COARSE_POINTER_HEADER_ICON_BUTTON_CLASS} ${CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS}`}
                  aria-label={toggleLabel}
                  aria-pressed={isOpen}
                  onClick={togglePanel}
                >
                  <Icon name={RIGHT_PANEL_TOGGLE_ICON_NAME} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{toggleLabel}</TooltipContent>
            </Tooltip>,
            togglePortalTarget,
          )
        : null}
      <div
        className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${
          flushPageInsets
            ? "-m-4 h-[calc(100%+2rem)] md:-m-5 md:h-[calc(100%+2.5rem)]"
            : "h-full"
        }`}
      >
        <SecondaryPanelLayout
          open={isOpen}
          onToggle={togglePanel}
          panelGroupKey={`plugin-panel-host:${panelHostId}`}
          resetKey={panelStateId}
          contentKey={panelStateId}
          mainPanelId={`plugin-panel-main-${panelHostId}`}
          main={children}
          renderPanel={({
            isMainCollapsed,
            onToggleMainCollapse,
            resizablePanelId,
          }) => (
            <ThreadSecondaryPanel
              activeTabId={tabs.activeTabId}
              tabs={NO_TABS}
              fixedTabs={fixedTabs}
              isOpen={isOpen}
              onClose={closePanel}
              isConversationCollapsed={isMainCollapsed}
              onToggleConversationCollapse={onToggleMainCollapse}
              resizablePanelId={resizablePanelId}
            />
          )}
        />
      </div>
    </>
  );
}
