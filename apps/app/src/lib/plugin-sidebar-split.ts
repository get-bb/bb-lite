import { useMemo } from "react";
import { useAtomValue } from "jotai";
import type {
  PluginSidebarSplitLayout,
  PluginSidebarThreadSplit,
} from "@bb/plugin/app";
import { usePaneContentSplitPanes } from "@/components/sidebar/paneContentSplitIndicator";
import { usePaneContentSplitDrag } from "@/components/sidebar/usePaneContentSplitDrag";
import { useThreadTitleDisplayText } from "@/components/thread/ThreadTitleMentions";
import { getThreadDisplayTitle } from "./thread-title";
import { useSidebarThreadEntry } from "./plugin-sidebar-hooks";
import {
  computePaneRects,
  countPanes,
  listPanes,
  type PaneContent,
  type SplitLayout,
} from "./split-layout";
import { splitLayoutAtom } from "./split-layout/atoms";

export function toPluginSidebarSplitLayout(
  layout: SplitLayout | null,
): PluginSidebarSplitLayout | null {
  if (layout === null || countPanes(layout.root) < 2) return null;
  const rects = computePaneRects(layout.root);
  return {
    panes: listPanes(layout.root).flatMap((pane) => {
      const rect = rects.get(pane.paneId);
      return rect === undefined
        ? []
        : [
            {
              paneId: pane.paneId,
              rect: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
              threadId:
                pane.content.kind === "thread" ? pane.content.threadId : null,
              isFocused: pane.paneId === layout.focusedPaneId,
            },
          ];
    }),
  };
}

export function useSidebarSplitLayout(): PluginSidebarSplitLayout | null {
  const layout = useAtomValue(splitLayoutAtom);
  return useMemo(() => toPluginSidebarSplitLayout(layout), [layout]);
}

export function useSidebarThreadSplit(
  threadId: string,
): PluginSidebarThreadSplit {
  const entry = useSidebarThreadEntry(threadId);
  const projectId = entry?.projectId ?? null;
  const label = useThreadTitleDisplayText(
    entry ? getThreadDisplayTitle(entry) : "",
  );
  const content = useMemo<PaneContent | null>(
    () => (projectId === null ? null : { kind: "thread", projectId, threadId }),
    [projectId, threadId],
  );
  const onPointerDown = usePaneContentSplitDrag({ content, label });
  const panes = usePaneContentSplitPanes(content);
  return useMemo<PluginSidebarThreadSplit>(
    () => ({
      splitProps: onPointerDown ? { onPointerDown } : {},
      isAvailable: content !== null,
      layout: panes === null ? null : { panes },
    }),
    [content, onPointerDown, panes],
  );
}
