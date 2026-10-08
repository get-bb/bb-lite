import { useAtomValue } from "jotai";
import type { SidebarSplitPane } from "@bb/plugin/app";
import { splitLayoutAtom } from "@bb/app-kit/lib/split-layout/atoms";
import {
  computePaneRects,
  findPaneByContent,
  listPanes,
  type PaneContent,
} from "@bb/app-kit/lib/split-layout/index";

export function usePaneContentSplitPanes(
  content: PaneContent | null,
): readonly SidebarSplitPane[] | null {
  const layout = useAtomValue(splitLayoutAtom);
  if (content === null || layout === null) return null;
  const panes = listPanes(layout.root);
  const mine = findPaneByContent(layout.root, content);
  if (panes.length < 2 || mine === null) return null;
  const rects = computePaneRects(layout.root);
  return panes.flatMap(({ paneId }) => {
    const rect = rects.get(paneId);
    return rect === undefined
      ? []
      : [
          {
            paneId,
            rect: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
            isMe: paneId === mine.paneId,
            isFocused: paneId === layout.focusedPaneId,
          },
        ];
  });
}
