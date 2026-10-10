import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type Key,
  type ReactNode,
} from "react";
import { useAtomValue } from "jotai";
import {
  Panel,
  PanelGroup,
  type ImperativePanelGroupHandle,
} from "react-resizable-panels";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { useResponsiveDrawerRealization } from "@bb/shared-ui/responsive-overlay";
import { cn } from "@bb/shared-ui/lib/utils";
import { CompactSecondaryPanelShelf } from "./CompactSecondaryPanelShelf";
import {
  useOptionalPaneContext,
  usePaneSecondaryPanelRegistration,
  type PaneSecondaryPanelViewModel,
} from "@bb/app-kit/views/thread-detail/PaneContext";
import {
  getPanelCollapseTransitionStyle,
  PANEL_COLLAPSE_TRANSITION_CLASS,
  usePanelCollapseTransitionsReady,
} from "@bb/app-kit/components/secondary-panel/panelTransitionTokens";
import { secondaryPanelWidthPercentAtom } from "@bb/app-kit/components/secondary-panel/threadSecondaryPanelAtoms";
import {
  isCompactSidebarDrawerShowing,
  subscribeCompactSidebarDrawerShowing,
} from "@bb/app-kit/components/ui/sidebar-mobile-drawer-visibility";
import {
  SecondaryPanelMinimumContext,
  useSecondaryPanelSizing,
} from "./secondaryPanelSizing";

const FULL_PANEL_SIZE_PERCENT = 100;

function noopToggleMainCollapse(): void {}

interface SecondaryPanelRenderArgs {
  presentation: "inline" | "drawer";
  isMainCollapsed: boolean;
  onToggleMainCollapse: () => void;
  resizablePanelId?: string;
}

interface SecondaryPanelLayoutProps {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  panelGroupKey?: Key;
  resetKey: Key;
  contentKey: string;
  drawerLabel: string;
  drawerFallback: ReactNode;
  mainPanelId: string;
  mainHeader?: ReactNode;
  main: ReactNode;
  collapse?: {
    active: boolean;
    onToggle: () => void;
  };
  renderPanel: (args: SecondaryPanelRenderArgs) => ReactNode;
  renderHostedPanel?: (panel: ReactNode) => ReactNode;
}

export function SecondaryPanelLayout({
  open,
  onToggle,
  onClose,
  panelGroupKey,
  resetKey,
  contentKey,
  drawerLabel,
  drawerFallback,
  mainPanelId,
  mainHeader,
  main,
  collapse,
  renderPanel,
  renderHostedPanel,
}: SecondaryPanelLayoutProps) {
  const { ref: sizingRef, minimum: minimumSize } = useSecondaryPanelSizing();
  const paneContext = useOptionalPaneContext();
  const secondaryPanelHost = paneContext?.secondaryPanelHost ?? null;
  const renderAsDrawer = useIsCompactViewport();
  const sidebarDrawerShowing = useSyncExternalStore(
    subscribeCompactSidebarDrawerShowing,
    isCompactSidebarDrawerShowing,
    () => false,
  );
  const previousSidebarDrawerShowing = useRef(sidebarDrawerShowing);
  useEffect(() => {
    const sidebarOpened =
      sidebarDrawerShowing && !previousSidebarDrawerShowing.current;
    previousSidebarDrawerShowing.current = sidebarDrawerShowing;
    if (!renderAsDrawer || !open || !sidebarOpened) return;
    onClose();
  }, [onClose, open, renderAsDrawer, sidebarDrawerShowing]);
  const transitionsReady = usePanelCollapseTransitionsReady(
    resetKey,
    !renderAsDrawer,
  );
  const persistedSecondaryWidthPercent = useAtomValue(
    secondaryPanelWidthPercentAtom,
  );
  const isMainCollapsed = open && !renderAsDrawer && collapse?.active === true;

  const horizontalPanelGroupRef = useRef<ImperativePanelGroupHandle | null>(
    null,
  );
  const persistedSecondaryWidthRef = useRef(persistedSecondaryWidthPercent);
  useEffect(() => {
    persistedSecondaryWidthRef.current = persistedSecondaryWidthPercent;
  }, [persistedSecondaryWidthPercent]);

  useLayoutEffect(() => {
    const group = horizontalPanelGroupRef.current;
    if (group === null || renderAsDrawer) {
      return;
    }
    if (group.getLayout().length !== 2) {
      return;
    }

    if (!open) {
      group.setLayout([FULL_PANEL_SIZE_PERCENT, 0]);
      return;
    }
    if (isMainCollapsed) {
      group.setLayout([0, FULL_PANEL_SIZE_PERCENT]);
      return;
    }

    const secondaryWidth = persistedSecondaryWidthRef.current;
    group.setLayout([FULL_PANEL_SIZE_PERCENT - secondaryWidth, secondaryWidth]);
  }, [isMainCollapsed, open, renderAsDrawer]);

  const { isContentRealized: isPanelRealized, realizeContent: realizePanel } =
    useResponsiveDrawerRealization({
      open,
      enabled: renderAsDrawer,
    });
  const handleDrawerContentAnimationEnd = useCallback(
    (animationEndedOpen: boolean) => {
      if (animationEndedOpen) realizePanel();
    },
    [realizePanel],
  );
  const resizablePanelId =
    secondaryPanelHost === null || paneContext === null
      ? undefined
      : `thread-detail-secondary-panel-${paneContext.paneId}`;

  const inlinePanel = useMemo(
    () =>
      renderAsDrawer
        ? null
        : renderPanel({
            presentation: "inline",
            isMainCollapsed,
            onToggleMainCollapse: collapse?.onToggle ?? noopToggleMainCollapse,
            resizablePanelId,
          }),
    [
      collapse?.onToggle,
      isMainCollapsed,
      renderAsDrawer,
      renderPanel,
      resizablePanelId,
    ],
  );
  const drawerPanel = useMemo(
    () =>
      renderAsDrawer
        ? renderPanel({
            presentation: "drawer",
            isMainCollapsed: false,
            onToggleMainCollapse: collapse?.onToggle ?? noopToggleMainCollapse,
          })
        : null,
    [collapse?.onToggle, renderAsDrawer, renderPanel],
  );
  const hostedPanelModel = useMemo<PaneSecondaryPanelViewModel>(
    () => ({
      contentKey,
      isMainCollapsed,
      isOpen: open,
      panel: renderHostedPanel?.(inlinePanel) ?? inlinePanel,
      onToggle,
      transitionsReady,
    }),
    [
      contentKey,
      inlinePanel,
      isMainCollapsed,
      onToggle,
      open,
      renderHostedPanel,
      transitionsReady,
    ],
  );
  usePaneSecondaryPanelRegistration(secondaryPanelHost, hostedPanelModel);

  const mainContent = (
    <div
      data-split-pane-id={
        secondaryPanelHost === null ? paneContext?.paneId : undefined
      }
      inert={isMainCollapsed}
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col transition-opacity",
        secondaryPanelHost === null && "h-full",
        PANEL_COLLAPSE_TRANSITION_CLASS,
        isMainCollapsed && "opacity-0",
      )}
    >
      {secondaryPanelHost === null ? mainHeader : null}
      {main}
    </div>
  );

  if (secondaryPanelHost !== null) {
    return (
      <>
        {mainHeader}
        {mainContent}
      </>
    );
  }

  return (
    <>
      <div ref={sizingRef} className="flex min-h-0 w-full min-w-0 flex-1">
        <PanelGroup
          key={panelGroupKey ?? resetKey}
          ref={horizontalPanelGroupRef}
          data-split-resize-grid-root=""
          direction="horizontal"
          className="@container h-full min-w-0 flex-1"
          style={{
            overflow: "clip",
            ...getPanelCollapseTransitionStyle(transitionsReady),
          }}
        >
          <Panel
            id={mainPanelId}
            {...(collapse === undefined
              ? {}
              : { collapsible: true, collapsedSize: 0 })}
            defaultSize={
              isMainCollapsed
                ? 0
                : open && !renderAsDrawer
                  ? FULL_PANEL_SIZE_PERCENT - persistedSecondaryWidthPercent
                  : FULL_PANEL_SIZE_PERCENT
            }
            minSize={minimumSize.min * 100}
            order={1}
            className={cn(
              "min-w-0 overflow-clip transition-[flex-grow,flex-basis]",
              PANEL_COLLAPSE_TRANSITION_CLASS,
            )}
          >
            {mainContent}
          </Panel>
          <SecondaryPanelMinimumContext.Provider value={minimumSize}>
            {inlinePanel}
          </SecondaryPanelMinimumContext.Provider>
        </PanelGroup>
      </div>
      {renderAsDrawer ? (
        <CompactSecondaryPanelShelf
          open={open}
          onClose={onClose}
          srLabel={drawerLabel}
          onContentAnimationEnd={handleDrawerContentAnimationEnd}
        >
          {isPanelRealized ? drawerPanel : drawerFallback}
        </CompactSecondaryPanelShelf>
      ) : null}
    </>
  );
}
