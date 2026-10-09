import { getDefaultStore } from "jotai";
import type { EventPayload, threads } from "@bb/plugin/app";
import { listPanes } from "@bb/app-kit/lib/split-layout";
import {
  maximizedPaneIdAtom,
  splitLayoutAtom,
} from "@bb/app-kit/lib/split-layout/atoms";

type PaneAction = EventPayload<typeof threads.paneAction>;

export function performPaneAction({ threadId, action }: PaneAction): void {
  const store = getDefaultStore();
  const layout = store.get(splitLayoutAtom);
  if (layout === null) return;
  const pane = listPanes(layout.root).find(
    ({ content }) => content.kind === "thread" && content.threadId === threadId,
  );
  if (pane === undefined) return;
  const maximized = store.get(maximizedPaneIdAtom) === pane.paneId;
  const next =
    action === "maximize" || action === "spotlight"
      ? pane.paneId
      : action === "toggle"
        ? maximized
          ? null
          : pane.paneId
        : maximized
          ? null
          : store.get(maximizedPaneIdAtom);
  store.set(maximizedPaneIdAtom, next);
}
