import { getDefaultStore } from "jotai";
import type { threads } from "@bb/plugin/app";
import type { z } from "zod";
import { listPanes } from "@bb/app-kit/lib/split-layout";
import {
  maximizedPaneIdAtom,
  splitLayoutAtom,
} from "@bb/app-kit/lib/split-layout/atoms";

type PaneAction = z.output<(typeof threads.paneAction)["payload"]>;

export function performPaneAction({ threadId, action }: PaneAction): void {
  const store = getDefaultStore();
  const layout = store.get(splitLayoutAtom);
  if (layout === null) return;
  const pane = listPanes(layout.root).find(
    ({ content }) => content.kind === "thread" && content.threadId === threadId,
  );
  if (pane === undefined) return;
  const maximized = store.get(maximizedPaneIdAtom) === pane.id;
  const next =
    action === "maximize" || action === "spotlight"
      ? pane.id
      : action === "toggle"
        ? maximized
          ? null
          : pane.id
        : maximized
          ? null
          : store.get(maximizedPaneIdAtom);
  store.set(maximizedPaneIdAtom, next);
}
