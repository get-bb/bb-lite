import type { PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "jotai";
import { useRouteNavigate } from "@/components/ui/app-route-anchor";
import { resolveThreadMentionDropTarget } from "@/lib/thread-mention-drop";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import {
  countPanes,
  findPaneByContent,
  listPanes,
  MAX_PANES,
  replacePaneContent,
  setFocus,
  splitPane,
  type PaneContent,
} from "@/lib/split-layout";
import {
  beginSplitDrag,
  decideThreadDrop,
  shouldEngageSidebarSplitDrag,
} from "@/lib/split-drag";
import { paneContentRoute } from "@/views/thread-detail/splitThreadNavigation";

interface PaneContentSplitDragOptions {
  content: PaneContent | null;
  label: string;
  dragActivation?: "sidebar" | "distance";
  onDragStart?: () => void;
}

export function usePaneContentSplitDrag({
  content,
  label,
  dragActivation = "sidebar",
  onDragStart,
}: PaneContentSplitDragOptions):
  | ((event: ReactPointerEvent<HTMLElement>) => void)
  | undefined {
  const store = useStore();
  const navigate = useRouteNavigate();
  if (content === null) return undefined;
  return (event) => {
    if (event.button !== 0) return;
    const rowEl = event.currentTarget;
    const sidebarRightEdge = (
      rowEl.closest('[data-sidebar="sidebar"]') ?? rowEl
    ).getBoundingClientRect().right;
    const startX = event.clientX;
    const startY = event.clientY;
    const startLayout = store.get(splitLayoutAtom);
    const startPanes = startLayout === null ? [] : listPanes(startLayout.root);
    const only = startPanes.length === 1 ? startPanes[0] : undefined;
    beginSplitDrag({
      ghostLabel: label,
      cancelSidebarReorderOnEngage: true,
      resolveAuxiliaryTarget:
        content.kind === "thread"
          ? (x, y) =>
              resolveThreadMentionDropTarget(x, y, {
                threadId: content.threadId,
                label,
              })
          : undefined,
      sourceEl: rowEl,
      fadeSourceOnEngage: false,
      renderGhost: false,
      onEngage: onDragStart,
      ...(only
        ? {
            fallback: {
              paneId: only.paneId,
              container: document.querySelector<HTMLElement>("main"),
            },
          }
        : {}),
      shouldEngage: (x, y) =>
        dragActivation === "distance"
          ? Math.hypot(x - startX, y - startY) > 12
          : shouldEngageSidebarSplitDrag({
              startX,
              startY,
              x,
              y,
              sidebarRightEdge,
            }),
      decide: (_paneId, zone) => {
        const layout = store.get(splitLayoutAtom);
        if (layout === null) return null;
        return decideThreadDrop({
          zone,
          threadAlreadyOpen: findPaneByContent(layout.root, content) !== null,
          atMaxPanes: countPanes(layout.root) >= MAX_PANES,
        });
      },
      onDrop: (target) => {
        const layout = store.get(splitLayoutAtom);
        if (layout === null) return;
        const existing = findPaneByContent(layout.root, content);
        const next =
          existing !== null
            ? setFocus(layout, existing.paneId)
            : target.zone === "center"
              ? replacePaneContent(layout, target.paneId, content)
              : splitPane(layout, target.paneId, target.zone, content);
        if (next !== layout) store.set(splitLayoutAtom, next);
        navigate(
          paneContentRoute(content),
          existing !== null ? { replace: true } : undefined,
        );
      },
    });
  };
}
