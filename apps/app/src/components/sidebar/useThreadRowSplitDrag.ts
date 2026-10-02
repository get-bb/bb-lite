import { useCallback, type PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "jotai";
import { useRouteNavigate } from "@/components/ui/app-route-anchor";
import { openThreadInSplit } from "@/lib/split-layout/openThreadInSplit";
import { beginSidebarPaneContentSplitDrag } from "./usePaneContentSplitDrag";

interface UseThreadRowSplitDragArgs {
  projectId: string;
  threadId: string;
  title: string;
}

export function useThreadRowSplitDrag({
  projectId,
  threadId,
  title,
}: UseThreadRowSplitDragArgs): {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  openInSplit: () => void;
} {
  const store = useStore();
  const navigate = useRouteNavigate();

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) {
        return;
      }
      beginSidebarPaneContentSplitDrag({
        event,
        store,
        navigate,
        content: { kind: "thread", projectId, threadId },
        label: title,
      });
    },
    [navigate, projectId, store, threadId, title],
  );

  const openInSplit = useCallback(() => {
    openThreadInSplit({
      store,
      navigate,
      projectId,
      threadId,
    });
  }, [navigate, projectId, store, threadId]);

  return {
    onPointerDown,
    openInSplit,
  };
}
