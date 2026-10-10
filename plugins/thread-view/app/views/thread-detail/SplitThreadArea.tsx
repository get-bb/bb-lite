import { CallError } from "@bb/plugin/app";
import { focusPaneComposer } from "bb-plugin-composer/contract";
import { cn } from "@bb/shared-ui/lib/utils";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import {
  PANE_DIRECTION_APP_COMMAND_IDS,
  PANE_FOCUS_APP_COMMAND_IDS,
} from "@bb/domain";
import { useAtomValue, useStore } from "jotai";
import {
  createContext,
  Fragment,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  getThreadRoutePath,
  type ThreadRoutePathArgs,
} from "@bb/app-kit/lib/route-paths";
import { useIsMutating } from "@tanstack/react-query";
import { useThread } from "@bb/app-kit/hooks/queries/thread-queries";
import {
  dimInactiveSplitsAtom,
  maximizedPaneIdAtom,
  splitLayoutAtom,
} from "@bb/app-kit/lib/split-layout/atoms";
import {
  computePaneRects,
  findPane,
  listPanes,
  movePane,
  removePane,
  replacePaneContent,
  resizeSplit,
} from "@bb/app-kit/lib/split-layout";
import {
  createSplitResizeFlexPair,
  createSplitResizeSnapSession,
} from "@bb/app-kit/lib/split-resize-snap";
import type {
  LayoutNode,
  PaneContent,
  PaneNode,
  SplitLayout,
  SplitPath,
  SplitSide,
} from "@bb/app-kit/lib/split-layout";
import {
  useAppCommandContext,
  useAppCommandHandler,
  useIndexedAppCommandHandlers,
} from "@bb/app-kit/components/commands/AppCommandProvider";
import {
  PaneContext,
  createPaneSecondaryPanelRegistry,
  type PaneContextValue,
  type PaneSecondaryPanelViewModel,
} from "@bb/app-kit/views/thread-detail/PaneContext";
import { ThreadDetailView } from "./ThreadDetailView";
import { RootComposeView } from "bb-plugin-composer/contract";
import { PluginPanelView } from "bb-plugin-side-panel/contract";
import {
  AppPageHeader,
  HEADER_ICON_BUTTON_CLASS,
  HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
} from "@bb/app-kit/components/layout/AppPageHeader";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { usePluginNavPanelChrome } from "@bb/app-kit/lib/plugin-nav-panel-chrome";
import {
  PluginPanelHeaderActions,
  PluginPanelHeaderCenter,
} from "bb-plugin-side-panel/contract";
import {
  focusedPaneRoute,
  focusPaneIn,
  getAdjacentPaneId,
  getDirectionalPaneId,
  reconcileLayoutForContent,
  replaceOriginPaneContent,
} from "@bb/app-kit/views/thread-detail/splitThreadNavigation";
import { SplitWorkspaceSecondaryPanelHost } from "bb-plugin-side-panel/contract";
import { SecondaryPanelHostLayoutContext } from "@bb/app-kit/components/secondary-panel/SecondaryPanelHostLayoutContext";
import {
  CONTEXT_INACTIVE_TEXT_CLASS,
  CONTEXT_SELECTION_SURFACE_CLASS,
} from "@bb/app-kit/components/ui/context-selection";
import { PaneMaximizeButton } from "./PaneMaximizeButton";
import { PluginPanelRightPanelHost } from "bb-plugin-side-panel/contract";
import { useImmediateRouteNavigate } from "@bb/app-kit/components/ui/app-route-anchor";

const PANE_SIDES = ["left", "right", "top", "bottom"] as const;
const PANE_ATTR = "data-split-pane-id";

function createSplitController(
  store: ReturnType<typeof useStore>,
  navigate: (path: string, options?: { replace?: boolean }) => void,
) {
  const registry = createPaneSecondaryPanelRegistry();
  let workspace: HTMLDivElement | null = null;
  let mounted = false;
  const setMaximized = (paneId: string | null) =>
    store.set(maximizedPaneIdAtom, paneId);
  const commit = (next: SplitLayout) => {
    const current = store.get(splitLayoutAtom);
    if (current === null || next === current) return;
    store.set(splitLayoutAtom, next);
    const maximized = store.get(maximizedPaneIdAtom);
    if (maximized !== null) {
      setMaximized(
        listPanes(next.root).length > 1 && findPane(next.root, maximized)
          ? next.focusedPaneId
          : null,
      );
    }
    const route = focusedPaneRoute(next);
    if (route !== null && route !== focusedPaneRoute(current)) {
      navigate(route, { replace: true });
    }
  };
  const update = (run: (current: SplitLayout) => SplitLayout | undefined) => {
    const current = store.get(splitLayoutAtom);
    const next = current === null ? undefined : run(current);
    if (next) commit(next);
  };
  return {
    registry,
    setMaximized,
    setWorkspace: (element: HTMLDivElement | null) => {
      workspace = element;
    },
    setMounted: (value: boolean) => {
      mounted = value;
    },
    findPaneElement: (paneId: string | null) =>
      [
        ...(workspace?.querySelectorAll<HTMLElement>(`[${PANE_ATTR}]`) ?? []),
      ].find((element) => element.dataset.splitPaneId === paneId),
    focusPane: (paneId: string) =>
      update((current) => focusPaneIn(current, paneId)),
    prunePane: (paneId: string) =>
      update((current) => removePane(current, paneId)),
    closePane: (paneId: string) =>
      update((current) =>
        listPanes(current.root).length > 1
          ? removePane(current, paneId)
          : findPane(current.root, paneId)?.content.kind === "new-thread"
            ? current
            : replacePaneContent(current, paneId, { kind: "new-thread" }),
      ),
    toggleMaximize: (paneId: string) => {
      const current = store.get(splitLayoutAtom);
      if (
        current === null ||
        listPanes(current.root).length < 2 ||
        findPane(current.root, paneId) === null
      ) {
        return;
      }
      const wasMaximized = store.get(maximizedPaneIdAtom) === paneId;
      commit(focusPaneIn(current, paneId));
      setMaximized(wasMaximized ? null : paneId);
    },
    movePaneToSide: (paneId: string, side: SplitSide) =>
      update((current) => {
        const rects = computePaneRects(current.root);
        const edge = (candidateId: string) => {
          const rect = rects.get(candidateId);
          if (rect === undefined) return 0;
          return side === "left"
            ? rect.x
            : side === "right"
              ? -(rect.x + rect.w)
              : side === "top"
                ? rect.y
                : -(rect.y + rect.h);
        };
        const target = listPanes(current.root)
          .filter((pane) => pane.paneId !== paneId)
          .sort((first, second) => edge(first.paneId) - edge(second.paneId))[0];
        return target && movePane(current, paneId, target.paneId, side);
      }),
    resize: (path: SplitPath, childIndex: number, fraction: number) =>
      update((current) => resizeSplit(current, path, childIndex, fraction)),
    navigateInPane: (
      paneId: string,
      origin: PaneContent,
      thread: ThreadRoutePathArgs,
    ) => {
      const current = store.get(splitLayoutAtom);
      const next =
        current &&
        replaceOriginPaneContent(current, paneId, origin, {
          kind: "thread",
          ...thread,
        });
      if (!next) return;
      store.set(splitLayoutAtom, next);
      if (mounted && next.focusedPaneId === paneId) {
        navigate(getThreadRoutePath(thread));
      }
    },
  };
}

type SplitController = ReturnType<typeof createSplitController>;

const SplitControllerContext = createContext<SplitController | null>(null);

function useSplitController(): SplitController {
  const controller = useContext(SplitControllerContext);
  if (controller === null) throw new Error("No split workspace");
  return controller;
}

export function SplitThreadArea({
  routeContent,
}: {
  routeContent: PaneContent;
}) {
  const navigate = useImmediateRouteNavigate();
  const store = useStore();
  const isCompactViewport = useIsCompactViewport();
  const storedLayout = useAtomValue(splitLayoutAtom);
  const storedMaximizedPaneId = useAtomValue(maximizedPaneIdAtom);
  const [controller] = useState(() => createSplitController(store, navigate));
  const [keyboardFocusPaneId, setKeyboardFocusPaneId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    controller.setMounted(true);
    return () => controller.setMounted(false);
  }, [controller]);
  useEffect(() => {
    store.set(splitLayoutAtom, (previous) =>
      reconcileLayoutForContent(previous, routeContent),
    );
  }, [routeContent, store]);

  const layout = storedLayout ?? reconcileLayoutForContent(null, routeContent);
  const panes = listPanes(layout.root);
  const onlyPane: PaneNode | undefined = isCompactViewport
    ? { type: "pane", paneId: layout.focusedPaneId, content: routeContent }
    : panes.length === 1
      ? panes[0]
      : undefined;
  const isSplitActive = onlyPane === undefined;
  const maximizedPaneId =
    isSplitActive &&
    storedMaximizedPaneId !== null &&
    findPane(layout.root, storedMaximizedPaneId) !== null
      ? storedMaximizedPaneId
      : null;
  const focusedPaneId = maximizedPaneId ?? layout.focusedPaneId;

  useEffect(() => {
    if (storedMaximizedPaneId === null) return;
    controller.setMaximized(
      maximizedPaneId === null ? null : layout.focusedPaneId,
    );
  }, [
    controller,
    layout.focusedPaneId,
    maximizedPaneId,
    storedMaximizedPaneId,
  ]);

  useEffect(() => {
    const paneId = keyboardFocusPaneId;
    const pane = paneId === null ? null : findPane(layout.root, paneId);
    const root = controller.findPaneElement(paneId);
    if (!root || !pane || layout.focusedPaneId !== paneId) return;
    let observer: MutationObserver | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = () =>
      setKeyboardFocusPaneId((current) =>
        current === paneId ? null : current,
      );
    const focusComposer = () => {
      const composer =
        root.isConnected && root.getAttribute("aria-hidden") !== "true"
          ? root.querySelector<HTMLElement>(
              "[data-promptbox] [contenteditable='true'], [data-promptbox] textarea:not(:disabled)",
            )
          : null;
      if (composer) focusPaneComposer(composer);
      return composer !== null && document.activeElement === composer;
    };
    const frame = requestAnimationFrame(() => {
      if (focusComposer()) return finish();
      const content =
        root.querySelector<HTMLElement>("[data-pane-content]") ?? root;
      const control =
        pane.content.kind === "thread"
          ? null
          : content.querySelector<HTMLElement>(
              "input:not(:disabled), textarea:not(:disabled), [contenteditable='true'], button:not(:disabled), a[href], [tabindex='0']",
            );
      (control ?? root).focus({ preventScroll: true });
      observer = new MutationObserver(() => {
        if (document.activeElement !== root || focusComposer()) finish();
      });
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["contenteditable", "disabled"],
      });
      timeout = setTimeout(finish, 1000);
    });
    document.addEventListener("pointerdown", finish, true);
    document.addEventListener("keydown", finish, true);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      clearTimeout(timeout);
      document.removeEventListener("pointerdown", finish, true);
      document.removeEventListener("keydown", finish, true);
    };
  }, [controller, keyboardFocusPaneId, layout]);

  const focusFromKeyboard = (paneId: string | null | undefined) => {
    if (!isSplitActive || !paneId) return false;
    controller.focusPane(paneId);
    setKeyboardFocusPaneId(paneId);
    return true;
  };
  useAppCommandContext("splitActive", isSplitActive);
  useIndexedAppCommandHandlers(PANE_DIRECTION_APP_COMMAND_IDS, (index) =>
    focusFromKeyboard(
      getDirectionalPaneId(
        layout.root,
        layout.focusedPaneId,
        PANE_SIDES[index] ?? "left",
      ),
    ),
  );
  useAppCommandHandler("pane.focus.previous", () => {
    focusFromKeyboard(getAdjacentPaneId(panes, layout.focusedPaneId, -1));
    return isSplitActive;
  });
  useAppCommandHandler("pane.focus.next", () => {
    focusFromKeyboard(getAdjacentPaneId(panes, layout.focusedPaneId, 1));
    return isSplitActive;
  });
  useIndexedAppCommandHandlers(PANE_FOCUS_APP_COMMAND_IDS, (index) => {
    focusFromKeyboard(panes[index]?.paneId);
    return isSplitActive;
  });
  useAppCommandHandler("pane.close", () => {
    if (isSplitActive) controller.closePane(layout.focusedPaneId);
    return isSplitActive;
  });
  useAppCommandHandler("pane.maximize.toggle", () => {
    if (isSplitActive) controller.toggleMaximize(focusedPaneId);
    return isSplitActive;
  });

  return (
    <SplitControllerContext.Provider value={controller}>
      {onlyPane ? (
        <PaneBody
          node={onlyPane}
          isFocused
          isSplitPane={false}
          isHidden={false}
          isMaximized={false}
          reservesWindowPanelToggle={false}
          isTopRow
          ownsWindowTopLeft
        />
      ) : (
        <div
          ref={(element) => controller.setWorkspace(element)}
          className="relative -m-4 flex min-h-0 min-w-0 flex-1 overflow-hidden md:-m-5"
        >
          <SplitWorkspaceSecondaryPanelHost
            focusedPaneId={focusedPaneId}
            isPaneMaximized={maximizedPaneId !== null}
            registry={controller.registry}
          >
            <SplitTree
              node={layout.root}
              path={[]}
              isTopRow
              isLeftEdge
              isRightEdge
              focusedPaneId={focusedPaneId}
              maximizedPaneId={maximizedPaneId}
              onPointerFocus={(paneId) => {
                setKeyboardFocusPaneId(null);
                controller.focusPane(paneId);
              }}
            />
          </SplitWorkspaceSecondaryPanelHost>
        </div>
      )}
    </SplitControllerContext.Provider>
  );
}

interface SplitTreeProps {
  node: LayoutNode;
  path: SplitPath;
  isTopRow: boolean;
  isLeftEdge: boolean;
  isRightEdge: boolean;
  focusedPaneId: string;
  maximizedPaneId: string | null;
  onPointerFocus: (paneId: string) => void;
}

function SplitTree(props: SplitTreeProps) {
  const { node, path, isTopRow, isLeftEdge, isRightEdge, maximizedPaneId } =
    props;
  const controller = useSplitController();
  const dimsInactiveSplits = useAtomValue(dimInactiveSplitsAtom);
  if (node.type === "pane") {
    const isFocused = node.paneId === props.focusedPaneId;
    const isMaximized = node.paneId === maximizedPaneId;
    const isHidden = maximizedPaneId !== null && !isMaximized;
    return (
      <div
        onPointerDown={() => props.onPointerFocus(node.paneId)}
        aria-hidden={isHidden || undefined}
        style={isHidden ? { contentVisibility: "hidden" } : undefined}
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 overflow-hidden",
          isHidden && "invisible pointer-events-none",
          isMaximized && "absolute inset-0 z-30",
        )}
        tabIndex={-1}
        data-split-pane-id={node.paneId}
        data-focused={isFocused ? "true" : "false"}
        data-maximized={isMaximized ? "true" : undefined}
      >
        {node.content.kind === "thread" ? (
          <PaneStaleWatcher
            key={node.content.threadId}
            threadId={node.content.threadId}
            paneId={node.paneId}
          />
        ) : null}
        <PaneBody
          node={node}
          isFocused={isFocused}
          isSplitPane
          isHidden={isHidden}
          isMaximized={isMaximized}
          reservesWindowPanelToggle={isMaximized || (isTopRow && isRightEdge)}
          isTopRow={isMaximized || isTopRow}
          ownsWindowTopLeft={
            maximizedPaneId !== null ? isMaximized : isTopRow && isLeftEdge
          }
        />
        <div
          aria-hidden
          data-pane-focus-scrim=""
          className={cn(
            "pointer-events-none absolute inset-0 z-20 transition-colors",
            isFocused || !dimsInactiveSplits
              ? "bg-transparent"
              : "bg-background/30",
          )}
        />
      </div>
    );
  }
  const lastIndex = node.children.length - 1;
  return (
    <div
      data-split-resize-grid-root=""
      className={cn(
        "flex min-h-0 min-w-0 flex-1",
        node.dir === "col" ? "flex-col" : "flex-row",
      )}
    >
      {node.children.map((child, index) => (
        <Fragment
          key={listPanes(child)
            .map((pane) => pane.paneId)
            .join("-")}
        >
          {index > 0 ? (
            <SplitDivider
              boundaryIndex={index}
              childCount={node.children.length}
              horizontal={node.dir === "row"}
              hidden={maximizedPaneId !== null}
              onResize={(fraction) =>
                controller.resize(path, index - 1, fraction)
              }
            />
          ) : null}
          <div
            className="flex min-h-0 min-w-0"
            style={{ flex: `${node.sizes[index] ?? 1} 1 0` }}
          >
            <SplitTree
              {...props}
              node={child}
              path={[...path, index]}
              isTopRow={isTopRow && (node.dir === "row" || index === 0)}
              isLeftEdge={isLeftEdge && (node.dir === "col" || index === 0)}
              isRightEdge={
                isRightEdge && (node.dir === "col" || index === lastIndex)
              }
            />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function PaneBody({
  node,
  isFocused,
  isSplitPane,
  isHidden,
  isMaximized,
  reservesWindowPanelToggle,
  isTopRow,
  ownsWindowTopLeft,
}: {
  node: PaneNode;
  isFocused: boolean;
  isSplitPane: boolean;
  isHidden: boolean;
  isMaximized: boolean;
  reservesWindowPanelToggle: boolean;
  isTopRow: boolean;
  ownsWindowTopLeft: boolean;
}) {
  const controller = useSplitController();
  const { paneId, content } = node;
  const canClose = isSplitPane || content.kind !== "new-thread";
  const secondaryPanelHost = useMemo(
    () =>
      isSplitPane
        ? {
            publish: (model: PaneSecondaryPanelViewModel) =>
              controller.registry.publish(paneId, model),
            clear: () => controller.registry.clear(paneId),
          }
        : null,
    [controller, isSplitPane, paneId],
  );
  const value = useMemo<PaneContextValue>(
    () => ({
      paneId,
      isFocused,
      isSplitPane,
      secondaryPanelHost,
      reservesWindowPanelToggle,
      isMaximized,
      isBoundedPane: isSplitPane,
      isTopRow,
      ownsWindowTopLeft,
      onRequestClose: canClose ? () => controller.closePane(paneId) : null,
      navigateInPane: (thread) =>
        controller.navigateInPane(paneId, content, thread),
      ...(isSplitPane
        ? {
            onToggleMaximize: () => controller.toggleMaximize(paneId),
            onMoveToSide: (side) => controller.movePaneToSide(paneId, side),
          }
        : { onToggleMaximize: null }),
    }),
    [
      canClose,
      content,
      controller,
      isFocused,
      isMaximized,
      isSplitPane,
      isTopRow,
      ownsWindowTopLeft,
      paneId,
      reservesWindowPanelToggle,
      secondaryPanelHost,
    ],
  );
  return (
    <PaneContext.Provider value={value}>
      {content.kind === "thread" ? (
        <ThreadDetailView
          projectId={content.projectId}
          threadId={content.threadId}
          timelineEnabled={!isHidden}
        />
      ) : (
        <NonThreadPaneContent content={content} pane={value} />
      )}
    </PaneContext.Provider>
  );
}

function NonThreadPaneContent({
  content,
  pane,
}: {
  content: Exclude<PaneContent, { kind: "thread" }>;
  pane: PaneContextValue;
}) {
  const navPanelChrome = usePluginNavPanelChrome();
  const dimsInactiveSplits = useAtomValue(dimInactiveSplitsAtom);
  const showsWindowPanelToggle =
    useContext(SecondaryPanelHostLayoutContext)?.pinsCornerToggle === true;
  const { isBoundedPane, isFocused, onRequestClose } = pane;
  const panelEntry =
    content.kind === "plugin-panel"
      ? navPanelChrome.find(
          ({ chrome }) =>
            chrome.pluginId === content.pluginId &&
            chrome.path === content.panelPath,
        )
      : undefined;
  const panel = panelEntry?.panel ?? undefined;
  const panelChrome = panelEntry?.chrome;
  const paneActions = (
    <>
      <PaneMaximizeButton />
      {onRequestClose ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
            CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
          )}
          aria-label="Close pane"
          onClick={onRequestClose}
        >
          <Icon
            name={
              content.kind === "new-thread"
                ? "CloseThreadPane"
                : "ClosePluginPane"
            }
          />
        </Button>
      ) : null}
    </>
  );
  const contentMarkup = (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        !isBoundedPane && content.kind === "new-thread" && "-m-4 md:-m-5",
      )}
    >
      {isBoundedPane || panel ? (
        <AppPageHeader
          ownsWindowTopLeft={pane.ownsWindowTopLeft}
          className={isBoundedPane ? "z-[21]" : undefined}
          center={
            <div
              data-pane-header-focus-tab={
                isBoundedPane && isFocused ? "" : undefined
              }
              className={cn(
                "relative flex min-w-0 flex-1 items-center",
                isBoundedPane && "-my-1 -ml-2 rounded-md px-2 py-1",
                isBoundedPane && isFocused && CONTEXT_SELECTION_SURFACE_CLASS,
              )}
            >
              {panelChrome ? (
                <PluginPanelHeaderCenter chrome={panelChrome} />
              ) : (
                <p
                  className={cn(
                    "relative truncate text-sm font-normal transition-colors",
                    isBoundedPane &&
                      !isFocused &&
                      dimsInactiveSplits &&
                      CONTEXT_INACTIVE_TEXT_CLASS,
                  )}
                >
                  New thread
                </p>
              )}
            </div>
          }
          actions={
            <>
              {panel && content.kind === "plugin-panel" ? (
                <PluginPanelHeaderActions
                  panel={panel}
                  subPath={content.subPath}
                  paneActions={paneActions}
                />
              ) : (
                paneActions
              )}
              {pane.reservesWindowPanelToggle && showsWindowPanelToggle ? (
                <span aria-hidden className={HEADER_ICON_BUTTON_CLASS} />
              ) : null}
            </>
          }
        />
      ) : null}
      <div
        data-pane-content=""
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col p-4 md:p-5",
          isBoundedPane && content.kind === "plugin-panel" && "isolate",
        )}
      >
        {content.kind === "new-thread" ? (
          <RootComposeView />
        ) : (
          <PluginPanelView
            pluginId={content.pluginId}
            panelPath={content.panelPath}
            subPath={content.subPath}
          />
        )}
      </div>
    </div>
  );
  return content.kind === "plugin-panel" ? (
    <Suspense key={`${content.pluginId}/${content.panelPath}`} fallback={null}>
      <PluginPanelRightPanelHost
        flushPageInsets={!isBoundedPane}
        pluginId={content.pluginId}
        panelPath={content.panelPath}
        subPath={content.subPath}
      >
        {contentMarkup}
      </PluginPanelRightPanelHost>
    </Suspense>
  ) : (
    contentMarkup
  );
}

function freezeOffscreenTimelineRows(panes: readonly HTMLElement[]) {
  const viewportRects = new Map<HTMLElement, DOMRect>();
  const frozen: [HTMLElement, string, string, number][] = [];
  for (const row of panes.flatMap((pane) => [
    ...pane.querySelectorAll<HTMLElement>("[data-timeline-row-id]"),
  ])) {
    let viewport = row.parentElement;
    while (viewport !== null && !viewportRects.has(viewport)) {
      const overflowY = window.getComputedStyle(viewport).overflowY;
      if (
        (overflowY === "auto" || overflowY === "scroll") &&
        viewport.scrollHeight > viewport.clientHeight
      ) {
        viewportRects.set(viewport, viewport.getBoundingClientRect());
      } else {
        viewport = viewport.parentElement;
      }
    }
    const bounds = viewport && viewportRects.get(viewport);
    const rect = row.getBoundingClientRect();
    if (
      bounds &&
      rect.height > 0 &&
      (rect.bottom < bounds.top - bounds.height ||
        rect.top > bounds.bottom + bounds.height)
    ) {
      frozen.push([
        row,
        row.style.containIntrinsicBlockSize,
        row.style.contentVisibility,
        rect.height,
      ]);
    }
  }
  for (const [row, , , height] of frozen) {
    row.style.containIntrinsicBlockSize = `${height}px`;
    row.style.contentVisibility = "hidden";
  }
  return () => {
    for (const [row, intrinsicSize, visibility] of frozen) {
      row.style.containIntrinsicBlockSize = intrinsicSize;
      row.style.contentVisibility = visibility;
    }
  };
}

function SplitDivider({
  boundaryIndex,
  childCount,
  horizontal,
  hidden,
  onResize,
}: {
  boundaryIndex: number;
  childCount: number;
  horizontal: boolean;
  hidden: boolean;
  onResize: (fraction: number) => void;
}) {
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelRef.current?.(), []);
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    cancelRef.current?.();
    const hitTarget = event.currentTarget;
    const divider = hitTarget.parentElement;
    const previous = divider?.previousElementSibling;
    const next = divider?.nextElementSibling;
    if (
      !divider ||
      !(previous instanceof HTMLElement) ||
      !(next instanceof HTMLElement)
    ) {
      return;
    }
    const previousRect = previous.getBoundingClientRect();
    const nextRect = next.getBoundingClientRect();
    const start = horizontal ? previousRect.left : previousRect.top;
    const end = horizontal ? nextRect.right : nextRect.bottom;
    if (end - start <= 0) return;
    const pointerId = event.pointerId;
    hitTarget.setPointerCapture(pointerId);
    divider.dataset.dragging = "true";
    const snapSession = createSplitResizeSnapSession(
      divider,
      horizontal ? "x" : "y",
      { boundaryIndex, childCount },
    );
    snapSession.resolve({
      end,
      pointer: horizontal ? event.clientX : event.clientY,
      start,
    });
    const pair = createSplitResizeFlexPair(previous, next);
    const restoreTimelineRows = freezeOffscreenTimelineRows([previous, next]);
    let pendingFraction: number | null = null;
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      pendingFraction = snapSession.resolve({
        end,
        pointer: horizontal ? moveEvent.clientX : moveEvent.clientY,
        start,
      }).fraction;
      pair.apply(pendingFraction);
    };
    const finish = (commit: boolean) => {
      if (cancelRef.current === null) return;
      cancelRef.current = null;
      delete divider.dataset.dragging;
      hitTarget.removeEventListener("pointermove", onMove);
      hitTarget.removeEventListener("pointerup", onEnd);
      hitTarget.removeEventListener("pointercancel", onEnd);
      hitTarget.removeEventListener("lostpointercapture", onEnd);
      if (hitTarget.hasPointerCapture?.(pointerId)) {
        hitTarget.releasePointerCapture(pointerId);
      }
      snapSession.clear();
      restoreTimelineRows();
      if (commit && pendingFraction !== null) onResize(pendingFraction);
      else pair.restore();
    };
    const onEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      finish(endEvent.type === "pointerup");
    };
    hitTarget.addEventListener("pointermove", onMove);
    hitTarget.addEventListener("pointerup", onEnd);
    hitTarget.addEventListener("pointercancel", onEnd);
    hitTarget.addEventListener("lostpointercapture", onEnd);
    cancelRef.current = () => finish(false);
  };

  return (
    <div
      role="separator"
      data-split-resize-grid-boundary={boundaryIndex}
      data-split-resize-grid-count={childCount}
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      className={cn(
        "group relative z-[25] flex-shrink-0 transition-colors",
        "bg-border-seam",
        "hover:bg-ring/40 data-[dragging]:bg-ring/40",
        hidden && "invisible pointer-events-none",
        horizontal ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
      )}
    >
      <div
        aria-hidden
        data-split-divider-hit-target=""
        onPointerDown={handlePointerDown}
        className={cn(
          "absolute z-10 touch-none bg-transparent",
          horizontal
            ? "-left-1.5 top-0 h-full w-3 cursor-col-resize"
            : "left-0 -top-1.5 h-3 w-full cursor-row-resize",
        )}
      />
    </div>
  );
}

function PaneStaleWatcher({
  threadId,
  paneId,
}: {
  threadId: string;
  paneId: string;
}) {
  const controller = useSplitController();
  const { data: thread, isError, error } = useThread(threadId);
  const hasObservedUnarchived = useRef(false);
  const unarchivesInFlight = useIsMutating({
    mutationKey: ["unarchive-thread"],
  });
  const archivesInFlight = useIsMutating({
    predicate: (mutation) =>
      mutation.options.meta?.lifecycleOperation === "archive_thread",
  });
  const isGone =
    (isError && error instanceof CallError && error.status === 404) ||
    (thread !== undefined && thread.deletedAt !== null);
  const isArchived = thread !== undefined && thread.archivedAt !== null;
  const isUnarchived = thread !== undefined && thread.archivedAt === null;
  useEffect(() => {
    if (isUnarchived && unarchivesInFlight === 0) {
      hasObservedUnarchived.current = true;
    }
    if (
      isGone ||
      (isArchived && archivesInFlight === 0 && hasObservedUnarchived.current)
    ) {
      controller.prunePane(paneId);
    }
  }, [
    archivesInFlight,
    controller,
    isArchived,
    isGone,
    isUnarchived,
    paneId,
    unarchivesInFlight,
  ]);
  return null;
}
