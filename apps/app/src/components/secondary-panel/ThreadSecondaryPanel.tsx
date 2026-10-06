import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Icon } from "@bb/shared-ui/icon";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import {
  Panel,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { Button } from "@bb/shared-ui/button";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import {
  COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
  COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  PANEL_COLLAPSE_TRANSITION_CLASS,
  PANEL_RESIZE_HANDLE_LAYER_CLASS,
  PANEL_RESIZE_HIT_TARGET_CLASS,
} from "./panelTransitionTokens";
import {
  PANEL_SCROLL_SLOT_CLASS,
  PANEL_TAB_CONTROL_CLASS,
} from "./panelChromeClasses";
import { SecondaryPanelMinimumContext } from "./secondaryPanelSizing";
import { RIGHT_PANEL_TOGGLE_ICON_NAME } from "./panelToggleControlState";
import { SecondaryPanelHostLayoutContext } from "./SecondaryPanelHostLayoutContext";
import { MobilePanelTabPager } from "./MobilePanelTabPager";
import {
  secondaryPanelWidthPercentAtom,
  threadSecondaryPanelResizingAtom,
} from "./threadSecondaryPanelAtoms";
import {
  SecondaryPanelTabStrip,
  type SecondaryPanelRenderableTab,
} from "./SecondaryPanelTabStrip";
import { usePanelResizeSnap } from "./usePanelResizeSnap";
import { CHROME_ROW_CLASS } from "@/lib/chrome-row";
import { IframeDragGuardOverlay } from "@/lib/iframe-drag-guard";
import {
  useAppCommandHandler,
  useAppCommandShortcut,
} from "@/components/commands/AppCommandProvider";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import type { AppShortcutPresentation } from "@/lib/app-keybindings";
import { TabPill } from "@/components/ui/tab-pill";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { PaneArrangementButton } from "@/views/thread-detail/PaneMaximizeButton";
export type { SecondaryPanelRenderableTab } from "./SecondaryPanelTabStrip";

const SECONDARY_RESIZABLE_PANEL_STYLE: CSSProperties = {
  pointerEvents: "auto",
};
const HIDE_PANEL_LABEL = "Hide right panel";

export interface SecondaryPanelFixedTab {
  ariaLabel: string;
  content: ReactNode;
  label: string;
  leadingVisual: ReactNode;
  onSelect: () => void;
  shortcut?: AppShortcutPresentation | null;
  tab: { id: string };
  title: string;
  toolbar?: ReactNode;
}

export interface ThreadSecondaryPanelProps {
  activeTabId: string | null;
  canNavigateTabs?: boolean;
  tabs: readonly SecondaryPanelRenderableTab[];
  fixedTabs: readonly SecondaryPanelFixedTab[];
  isOpen: boolean;
  resizablePanelId?: string;
  onClose: () => void;
  onOpenNewTab?: () => void;
  isConversationCollapsed: boolean;
  onToggleConversationCollapse: () => void;
  renderAsDrawer: boolean;
}

export function ThreadSecondaryPanel({
  activeTabId,
  canNavigateTabs = true,
  tabs,
  fixedTabs,
  isOpen,
  resizablePanelId = "thread-detail-secondary-panel",
  onClose,
  onOpenNewTab,
  isConversationCollapsed,
  onToggleConversationCollapse,
  renderAsDrawer,
}: ThreadSecondaryPanelProps) {
  const newTabShortcut = useAppCommandShortcut("panel.newTab");
  const togglePanelShortcut = useAppCommandShortcut("panel.toggle");
  const persistedWidthPercent = useAtomValue(secondaryPanelWidthPercentAtom);
  const setPersistedWidthPercent = useSetAtom(secondaryPanelWidthPercentAtom);
  const isResizing = useAtomValue(threadSecondaryPanelResizingAtom);
  const setIsResizing = useSetAtom(threadSecondaryPanelResizingAtom);
  const panelRef = useRef<HTMLElement>(null);
  const resizablePanelRef = useRef<ImperativePanelHandle | null>(null);
  const lastSizeRef = useRef(persistedWidthPercent);
  const hasExpandedRef = useRef(false);
  const minimumSize = useContext(SecondaryPanelMinimumContext);
  const hostLayout = useContext(SecondaryPanelHostLayoutContext);
  const [realized, setRealized] = useState(isOpen);
  if (isOpen && !realized) setRealized(true);

  const handlePointerResize = useCallback((leadingFraction: number) => {
    resizablePanelRef.current?.resize((1 - leadingFraction) * 100);
  }, []);
  const handleDragging = useCallback(
    (isDragging: boolean) => {
      setIsResizing(isDragging);
      if (!isDragging && lastSizeRef.current > 0) {
        setPersistedWidthPercent(lastSizeRef.current);
      }
    },
    [setIsResizing, setPersistedWidthPercent],
  );
  const resizeHitTargetRef = usePanelResizeSnap({
    onResize: handlePointerResize,
    onDragging: handleDragging,
  });
  const handlePanelResize = useCallback((size: number) => {
    if (size <= 0) return;
    hasExpandedRef.current = true;
    lastSizeRef.current = size;
    panelRef.current?.style.setProperty(
      "--secondary-swipe-width",
      `${size}cqw`,
    );
  }, []);
  const previousOpenRef = useRef(isOpen);
  useEffect(() => {
    if (previousOpenRef.current === isOpen) return;
    previousOpenRef.current = isOpen;
    if (isOpen) resizablePanelRef.current?.expand(lastSizeRef.current);
    else resizablePanelRef.current?.collapse();
  }, [isOpen]);
  useLayoutEffect(() => {
    const panel = panelRef.current?.closest<HTMLElement>("[data-panel]");
    const size = Number.parseFloat(panel?.style.flexGrow ?? "");
    if (Number.isFinite(size)) handlePanelResize(size);
  }, [handlePanelResize, isOpen, resizablePanelId]);
  const handlePanelCollapse = () => {
    if (!isOpen || hostLayout?.isSuppressed || !hasExpandedRef.current) return;
    hasExpandedRef.current = false;
    onClose();
  };
  const isLayoutOpen =
    (hostLayout?.isOpen ?? isOpen) && !hostLayout?.isSuppressed;

  const activeTab = tabs.find((tab) => tab.tab.id === activeTabId);
  const activeFixedTab =
    activeTab === undefined
      ? (fixedTabs.find((fixedTab) => fixedTab.tab.id === activeTabId) ??
        fixedTabs[0])
      : undefined;
  const shownTab =
    activeTab ?? (activeFixedTab === undefined ? tabs[0] : undefined);
  const shownTabId = shownTab?.tab.id ?? activeFixedTab?.tab.id ?? null;
  const fillsRegion =
    shownTab?.tab.kind === "terminal" || shownTab?.contentFillsRegion === true;

  const navigateTab = (direction: -1 | 1) => {
    const entries = [...fixedTabs, ...tabs];
    if (!canNavigateTabs || !isLayoutOpen || entries.length === 0) return false;
    const index = entries.findIndex((entry) => entry.tab.id === shownTabId);
    entries[(index + direction + entries.length) % entries.length]?.onSelect();
    window.requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLElement>(
          '[role="toolbar"] button[aria-pressed="true"]',
        )
        ?.focus({ preventScroll: true });
    });
    return true;
  };
  useAppCommandHandler("panel.previousTab", () => navigateTab(-1));
  useAppCommandHandler("panel.nextTab", () => navigateTab(1));
  const navigateNewTabItem = (direction: -1 | 1) => {
    const items = Array.from(
      (canNavigateTabs && isLayoutOpen ? panelRef.current : null)
        ?.querySelector("[data-panel-new-tab-page]")
        ?.querySelectorAll<HTMLElement>(
          "[data-panel-new-tab-item]:not(:disabled)",
        ) ?? [],
    );
    if (items.length === 0) return false;
    const index = items.findIndex((item) => item === document.activeElement);
    const next =
      items[
        index < 0
          ? direction === 1
            ? 0
            : items.length - 1
          : (index + direction + items.length) % items.length
      ];
    next?.focus({ preventScroll: true });
    next?.scrollIntoView({ block: "nearest" });
    return true;
  };
  useAppCommandHandler("panel.previousNewTabItem", () =>
    navigateNewTabItem(-1),
  );
  useAppCommandHandler("panel.nextNewTabItem", () => navigateNewTabItem(1));

  const newTabControl =
    onOpenNewTab === undefined ? null : (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(
          renderAsDrawer
            ? PANEL_TAB_CONTROL_CLASS
            : `${COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS} shrink-0 ${CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS}`,
          "text-muted-foreground/70 hover:text-foreground focus:ring-1 focus:ring-ring",
        )}
        onClick={onOpenNewTab}
        data-panel-new-tab=""
        aria-label={
          newTabShortcut
            ? `Open new tab (${newTabShortcut.label})`
            : "Open new tab"
        }
        aria-keyshortcuts={newTabShortcut?.ariaKeyshortcuts}
      >
        <Icon name="Plus" />
      </Button>
    );
  const panelSurface = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          "shrink-0 select-none",
          activeFixedTab?.toolbar != null && "flex flex-col",
          "bg-sidebar",
        )}
      >
        <div
          data-testid="thread-secondary-panel-top-chrome"
          className={cn(
            CHROME_ROW_CLASS,
            "min-w-0 justify-between gap-2",
            renderAsDrawer ? "px-2" : "px-4",
          )}
        >
          <div
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1",
              renderAsDrawer && "gap-0",
              `transition-[padding] ${PANEL_COLLAPSE_TRANSITION_CLASS}`,
            )}
            role="toolbar"
            aria-label="Right panel views"
          >
            {renderAsDrawer ? (
              <MobilePanelTabPager
                activeTabId={shownTabId}
                fixedTabs={fixedTabs.map((tab) => ({
                  id: tab.tab.id,
                  label: tab.label,
                  ariaLabel: tab.ariaLabel,
                  leadingVisual: tab.leadingVisual,
                  onSelect: tab.onSelect,
                }))}
                tabs={tabs.map((tab) => ({
                  id: tab.tab.id,
                  label: tab.label,
                  ariaLabel: tab.label,
                  leadingVisual: tab.leadingVisual,
                  onSelect: tab.onSelect,
                  onClose: tab.onClose,
                }))}
                newTabControl={newTabControl}
              />
            ) : (
              <>
                {fixedTabs.map((fixedTab) => (
                  <Tooltip key={fixedTab.tab.id}>
                    <TooltipTrigger asChild>
                      <div
                        data-testid={
                          fixedTab.label === "Info"
                            ? "thread-info-tab"
                            : undefined
                        }
                        className="shrink-0"
                      >
                        <TabPill
                          label={fixedTab.label}
                          ariaLabel={
                            fixedTab.shortcut
                              ? `${fixedTab.ariaLabel} (${fixedTab.shortcut.label})`
                              : fixedTab.ariaLabel
                          }
                          ariaKeyshortcuts={fixedTab.shortcut?.ariaKeyshortcuts}
                          iconOnly
                          leadingVisual={fixedTab.leadingVisual}
                          title={fixedTab.title}
                          isActive={activeFixedTab?.tab.id === fixedTab.tab.id}
                          onSelect={fixedTab.onSelect}
                          closeAction={null}
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>{fixedTab.title}</TooltipContent>
                  </Tooltip>
                ))}
                {tabs.length > 0 ? (
                  <SecondaryPanelTabStrip
                    activeTabId={shownTabId}
                    tabs={tabs}
                  />
                ) : null}
                {newTabControl}
              </>
            )}
          </div>
          <div
            className={cn(
              "flex min-w-0 shrink-0 items-center gap-1",
              renderAsDrawer && "gap-0",
            )}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {renderAsDrawer ? null : (
              <PaneArrangementButton
                className="shrink-0"
                isFullScreen={isConversationCollapsed}
                onToggleFullScreen={onToggleConversationCollapse}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                renderAsDrawer
                  ? PANEL_TAB_CONTROL_CLASS
                  : `${COARSE_POINTER_HEADER_ICON_BUTTON_CLASS} shrink-0 ${CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS}`,
                CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
                "relative",
              )}
              onClick={onClose}
              aria-label={
                togglePanelShortcut
                  ? `${HIDE_PANEL_LABEL} (${togglePanelShortcut.label})`
                  : HIDE_PANEL_LABEL
              }
              aria-keyshortcuts={togglePanelShortcut?.ariaKeyshortcuts}
            >
              <Icon name={RIGHT_PANEL_TOGGLE_ICON_NAME} />
              <AppCommandShortcutHint
                shortcut={togglePanelShortcut}
                className="absolute right-full mr-1"
              />
            </Button>
          </div>
        </div>
        {activeFixedTab?.toolbar}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-sidebar">
        {shownTab !== undefined ? (
          <div
            key={shownTab.tab.id}
            className={
              fillsRegion
                ? "min-h-0 flex-1 overflow-hidden"
                : cn(PANEL_SCROLL_SLOT_CLASS, "pb-3")
            }
            data-file-preview-scroll-container={fillsRegion ? undefined : ""}
          >
            {shownTab.renderContent()}
          </div>
        ) : (
          (activeFixedTab?.content ?? (
            <EmptyStatePanel className="m-4 rounded-lg">
              This panel view is unavailable.
            </EmptyStatePanel>
          ))
        )}
      </div>
    </div>
  );

  const asideMarkup = (
    <aside
      ref={panelRef}
      aria-hidden={!isOpen}
      inert={!isOpen}
      style={
        !renderAsDrawer && !isResizing
          ? {
              width: isConversationCollapsed
                ? "100%"
                : `var(--secondary-swipe-width, ${persistedWidthPercent}cqw)`,
            }
          : undefined
      }
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden bg-sidebar",
        renderAsDrawer && "min-w-0 flex-1",
        !renderAsDrawer && [
          "absolute inset-y-0 left-0",
          hostLayout === null &&
            !isConversationCollapsed &&
            "border-l border-border-seam",
          isResizing && "right-0",
          !isOpen && "pointer-events-none",
        ],
      )}
    >
      {realized ? panelSurface : null}
      <IframeDragGuardOverlay active={isResizing} cursor="col-resize" />
    </aside>
  );

  if (renderAsDrawer) {
    return asideMarkup;
  }

  return (
    <>
      <PanelResizeHandle
        id="thread-detail-secondary-panel-handle"
        disabled={!isOpen || isConversationCollapsed}
        data-panel-resize-snap-handle=""
        hitAreaMargins={{ coarse: 0, fine: 0 }}
        tabIndex={-1}
        className={cn(
          "group relative shrink-0 overflow-visible transition-[width,opacity,background-color]",
          PANEL_RESIZE_HANDLE_LAYER_CLASS,
          PANEL_COLLAPSE_TRANSITION_CLASS,
          isConversationCollapsed ? "cursor-default" : "cursor-col-resize",
          hostLayout !== null
            ? [
                "bg-border-seam hover:bg-ring/40",
                isOpen && !isConversationCollapsed
                  ? "w-px opacity-100"
                  : "pointer-events-none w-0 opacity-0",
                isResizing && "bg-ring/40",
              ]
            : [
                "bg-transparent",
                isOpen && !isConversationCollapsed
                  ? "w-0 opacity-100"
                  : "pointer-events-none w-0 opacity-0",
                isResizing && "bg-accent/20",
              ],
        )}
        aria-label="Resize thread and right panel"
      >
        <span
          aria-hidden
          ref={resizeHitTargetRef}
          data-panel-resize-hit-target=""
          className={PANEL_RESIZE_HIT_TARGET_CLASS}
        />
        {hostLayout !== null ? null : (
          <span
            className={cn(
              "pointer-events-none absolute inset-y-0 left-full z-10 w-px transition-colors",
              isResizing
                ? "bg-accent-foreground/50"
                : "bg-border-seam group-hover:bg-accent-foreground/35",
            )}
          />
        )}
      </PanelResizeHandle>
      <Panel
        ref={resizablePanelRef}
        id={resizablePanelId}
        collapsible
        collapsedSize={0}
        defaultSize={
          isLayoutOpen
            ? isConversationCollapsed
              ? 100
              : persistedWidthPercent
            : 0
        }
        minSize={(1 - minimumSize.max) * 100}
        maxSize={isConversationCollapsed ? 100 : (1 - minimumSize.min) * 100}
        onCollapse={handlePanelCollapse}
        onResize={handlePanelResize}
        order={2}
        style={SECONDARY_RESIZABLE_PANEL_STYLE}
        className={cn(
          "min-w-0 overflow-clip",
          `relative transition-[flex-grow,flex-basis] ${PANEL_COLLAPSE_TRANSITION_CLASS}`,
        )}
      >
        {asideMarkup}
      </Panel>
    </>
  );
}
