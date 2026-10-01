import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type Key,
  type ReactNode,
} from "react";
import { useAtomValue } from "jotai";
import {
  Panel,
  PanelGroup,
  type ImperativePanelGroupHandle,
} from "react-resizable-panels";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  useOptionalPaneContext,
  usePaneSecondaryPanelRegistration,
  type PaneSecondaryPanelViewModel,
} from "@/views/thread-detail/PaneContext";
import {
  getPanelCollapseTransitionStyle,
  PANEL_COLLAPSE_TRANSITION_CLASS,
  usePanelCollapseTransitionsReady,
} from "./panelTransitionTokens";
import { secondaryPanelWidthPercentAtom } from "./threadSecondaryPanelAtoms";
import {
  SecondaryPanelMinimumContext,
  useSecondaryPanelSizing,
} from "./secondaryPanelSizing";

const FULL_PANEL_SIZE_PERCENT = 100;

function noopToggleMainCollapse(): void {}

interface SecondaryPanelRenderArgs {
  isMainCollapsed: boolean;
  onToggleMainCollapse: () => void;
  resizablePanelId?: string;
}

interface SecondaryPanelLayoutProps {
  open: boolean;
  onToggle: () => void;
  panelGroupKey?: Key;
  resetKey: Key;
  contentKey: string;
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
  panelGroupKey,
  resetKey,
  contentKey,
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
  const transitionsReady = usePanelCollapseTransitionsReady(resetKey);
  const persistedSecondaryWidthPercent = useAtomValue(
    secondaryPanelWidthPercentAtom,
  );
  const isMainCollapsed = open && collapse?.active === true;

  const horizontalPanelGroupRef = useRef<ImperativePanelGroupHandle | null>(
    null,
  );
  const persistedSecondaryWidthRef = useRef(persistedSecondaryWidthPercent);
  useEffect(() => {
    persistedSecondaryWidthRef.current = persistedSecondaryWidthPercent;
  }, [persistedSecondaryWidthPercent]);

  useLayoutEffect(() => {
    const group = horizontalPanelGroupRef.current;
    if (group === null) {
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
  }, [isMainCollapsed, open]);

  const resizablePanelId =
    secondaryPanelHost === null || paneContext === null
      ? undefined
      : `thread-detail-secondary-panel-${paneContext.paneId}`;

  const inlinePanel = useMemo(
    () =>
      renderPanel({
        isMainCollapsed,
        onToggleMainCollapse: collapse?.onToggle ?? noopToggleMainCollapse,
        resizablePanelId,
      }),
    [collapse?.onToggle, isMainCollapsed, renderPanel, resizablePanelId],
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
              : open
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
  );
}
