import type { ThreadRoutePathArgs } from "@/lib/route-paths";
import type { ThreadOpenSplit, ThreadPaneAction } from "@bb/server-contract";
import {
  computePaneRects,
  countPanes,
  findPane,
  findPaneByContent,
  findPaneByThread,
  isSamePaneContent,
  MAX_PANES,
  replacePaneContent,
  setFocus,
  splitPane,
} from "@/lib/split-layout";
import type {
  LayoutNode,
  PaneContent,
  PaneNode,
  SplitLayout,
  SplitSide,
} from "@/lib/split-layout";
import { matchPath } from "react-router-dom";
import {
  APP_ROOT_ROUTE_PATH,
  getPluginPanelRoutePath,
  getRootComposeRoutePath,
  getThreadRoutePath,
  PLUGIN_PANEL_ROUTE_PATH,
} from "@/lib/route-paths";

export function paneContentRoute(content: PaneContent): string {
  if (content.kind === "thread") return getThreadRoutePath(content);
  if (content.kind === "new-thread") return getRootComposeRoutePath();
  return getPluginPanelRoutePath({
    pluginId: content.pluginId,
    path: content.panelPath,
    subPath: content.subPath,
  });
}

export function paneContentForPathname(pathname: string): PaneContent | null {
  if (pathname === APP_ROOT_ROUTE_PATH) return { kind: "new-thread" };
  const thread = matchPath(
    { path: "/projects/:projectId/threads/:threadId", end: false },
    pathname,
  );
  if (thread?.params.projectId && thread.params.threadId) {
    return {
      kind: "thread",
      projectId: thread.params.projectId,
      threadId: thread.params.threadId,
    };
  }
  const panel = matchPath(PLUGIN_PANEL_ROUTE_PATH, pathname);
  if (panel?.params.pluginId && panel.params.panelPath) {
    return {
      kind: "plugin-panel",
      pluginId: panel.params.pluginId,
      panelPath: panel.params.panelPath,
      subPath: panel.params["*"] ?? "",
    };
  }
  return null;
}

export function focusPaneIn(layout: SplitLayout, paneId: string): SplitLayout {
  return layout.focusedPaneId === paneId ? layout : setFocus(layout, paneId);
}

export function reconcileLayoutForContent(
  layout: SplitLayout | null,
  content: PaneContent,
): SplitLayout {
  if (layout === null) {
    return {
      root: { type: "pane", paneId: "pane-1", content },
      focusedPaneId: "pane-1",
    };
  }
  const existing = findPaneByContent(layout.root, content);
  if (existing === null) {
    return replacePaneContent(layout, layout.focusedPaneId, content);
  }
  return focusPaneIn(
    existing.content.kind === "plugin-panel" &&
      content.kind === "plugin-panel" &&
      existing.content.subPath !== content.subPath
      ? replacePaneContent(layout, existing.paneId, content)
      : layout,
    existing.paneId,
  );
}

export function replaceOriginPaneContent(
  layout: SplitLayout,
  paneId: string,
  originContent: PaneContent,
  content: PaneContent,
): SplitLayout | null {
  const pane = findPane(layout.root, paneId);
  if (pane === null || !isSamePaneContent(pane.content, originContent)) {
    return null;
  }
  return {
    ...replacePaneContent(layout, paneId, content),
    focusedPaneId: layout.focusedPaneId,
  };
}

export function focusedPaneRoute(layout: SplitLayout): string | null {
  const focused = findPane(layout.root, layout.focusedPaneId);
  return focused === null ? null : paneContentRoute(focused.content);
}

export function applyThreadOpenToLayout(
  layout: SplitLayout | null,
  thread: ThreadRoutePathArgs,
  split: ThreadOpenSplit,
): SplitLayout {
  const content: PaneContent = { kind: "thread", ...thread };
  if (layout === null) return reconcileLayoutForContent(null, content);
  const existing = findPaneByContent(layout.root, content);
  if (existing !== null) return focusPaneIn(layout, existing.paneId);
  return split === "replace" || countPanes(layout.root) >= MAX_PANES
    ? replacePaneContent(layout, layout.focusedPaneId, content)
    : splitPane(
        layout,
        layout.focusedPaneId,
        split === "down" ? "bottom" : split,
        content,
      );
}

export function applyThreadPaneActionToLayout(
  layout: SplitLayout,
  maximizedPaneId: string | null,
  thread: ThreadRoutePathArgs,
  action: ThreadPaneAction,
): {
  layout: SplitLayout;
  maximizedPaneId: string | null;
  dimInactiveSplits: boolean | null;
} {
  const pane = findPaneByThread(layout.root, thread.projectId, thread.threadId);
  const unchanged = { layout, maximizedPaneId, dimInactiveSplits: null };
  if (pane === null || countPanes(layout.root) < 2) return unchanged;
  const isMaximized = maximizedPaneId === pane.paneId;
  if (action === "spotlight" || action === "clear-spotlight") {
    return {
      layout: focusPaneIn(layout, pane.paneId),
      maximizedPaneId,
      dimInactiveSplits: action === "spotlight",
    };
  }
  if (action === "restore" || (action === "toggle" && isMaximized)) {
    return isMaximized ? { ...unchanged, maximizedPaneId: null } : unchanged;
  }
  return {
    layout: focusPaneIn(layout, pane.paneId),
    maximizedPaneId: pane.paneId,
    dimInactiveSplits: null,
  };
}

export function getAdjacentPaneId(
  panes: readonly PaneNode[],
  focusedPaneId: string,
  offset: -1 | 1,
): string | null {
  if (panes.length < 2) return null;
  const index = panes.findIndex((pane) => pane.paneId === focusedPaneId);
  return (
    panes[(Math.max(index, 0) + offset + panes.length) % panes.length]
      ?.paneId ?? null
  );
}

export function getDirectionalPaneId(
  root: LayoutNode,
  focusedPaneId: string,
  direction: SplitSide,
): string | null {
  const rects = computePaneRects(root);
  const focused = rects.get(focusedPaneId);
  if (!focused) return null;
  const horizontal = direction === "left" || direction === "right";
  const forward = direction === "right" || direction === "bottom";
  const start = horizontal ? focused.x : focused.y;
  const size = horizontal ? focused.w : focused.h;
  const crossStart = horizontal ? focused.y : focused.x;
  const crossSize = horizontal ? focused.h : focused.w;
  let nearest: string | null = null;
  let nearestGap = Infinity;
  let nearestOffset = Infinity;
  for (const [paneId, rect] of rects) {
    if (paneId === focusedPaneId) continue;
    const candidateStart = horizontal ? rect.x : rect.y;
    const candidateSize = horizontal ? rect.w : rect.h;
    const candidateCrossStart = horizontal ? rect.y : rect.x;
    const candidateCrossSize = horizontal ? rect.h : rect.w;
    const overlap =
      Math.min(
        crossStart + crossSize,
        candidateCrossStart + candidateCrossSize,
      ) - Math.max(crossStart, candidateCrossStart);
    const gap = forward
      ? candidateStart - start - size
      : start - candidateStart - candidateSize;
    if (gap < -1e-9 || overlap <= 1e-9) continue;
    const offset = Math.abs(
      candidateCrossStart + candidateCrossSize / 2 - crossStart - crossSize / 2,
    );
    if (
      gap < nearestGap - 1e-9 ||
      (Math.abs(gap - nearestGap) <= 1e-9 && offset < nearestOffset)
    ) {
      nearest = paneId;
      nearestGap = gap;
      nearestOffset = offset;
    }
  }
  return nearest;
}
