import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
  createBooleanPreferenceAtom,
  createTabScopedStorage,
} from "@/lib/browser-storage";
import {
  getThreadRoutePath,
  type ThreadRoutePathArgs,
} from "@/lib/route-paths";
import {
  countPanes,
  deserializeSplitLayout,
  findPane,
  findPaneByContent,
  listPanes,
  MAX_PANES,
  removePane,
  replacePaneContent,
  serializeSplitLayout,
  setFocus,
  SPLIT_LAYOUT_STORAGE_KEY,
  splitPane,
  type PaneContent,
  type SplitLayout,
} from "./index";

export const splitLayoutAtom = atomWithStorage<SplitLayout | null>(
  SPLIT_LAYOUT_STORAGE_KEY,
  null,
  createTabScopedStorage<SplitLayout | null>({
    parse: deserializeSplitLayout,
    serialize: (value) => (value === null ? "" : serializeSplitLayout(value)),
  }),
  { getOnInit: true },
);

export const maximizedPaneIdAtom = atomWithStorage<string | null>(
  "bb.splitLayout.maximizedPaneId",
  null,
  createTabScopedStorage<string | null>({
    parse: (storedValue, initialValue) => storedValue || initialValue,
    serialize: (value) => value ?? "",
  }),
  { getOnInit: true },
);

export const dimInactiveSplitsAtom = createBooleanPreferenceAtom(
  "bb.splitLayout.dimInactiveSplits",
  true,
);

export interface ClosePanesForThreadsResult {
  removedAny: boolean;
  focusedRoute: ThreadRoutePathArgs | null;
}

export const closePanesForThreadsAtom = atom(
  null,
  (get, set, threadIds: readonly string[]): ClosePanesForThreadsResult => {
    const current = get(splitLayoutAtom);
    const isClosing = (content: PaneContent) =>
      content.kind === "thread" && threadIds.includes(content.threadId);
    let layout = current;
    while (layout !== null) {
      const pane = listPanes(layout.root).find((candidate) =>
        isClosing(candidate.content),
      );
      const next: SplitLayout =
        pane === undefined ? layout : removePane(layout, pane.paneId);
      if (next === layout) break;
      layout = next;
    }
    if (current === null || layout === null || layout === current) {
      return { removedAny: false, focusedRoute: null };
    }
    const focused = findPane(layout.root, layout.focusedPaneId)?.content;
    const survives = focused?.kind === "thread" && !isClosing(focused);
    const maximized = get(maximizedPaneIdAtom);
    if (
      !survives ||
      (maximized !== null &&
        (countPanes(layout.root) < 2 ||
          findPane(layout.root, maximized) === null))
    ) {
      set(maximizedPaneIdAtom, null);
    }
    set(splitLayoutAtom, survives ? layout : null);
    return {
      removedAny: true,
      focusedRoute: survives
        ? { projectId: focused.projectId, threadId: focused.threadId }
        : null,
    };
  },
);

type NavigateState = Record<string, unknown>;

interface SplitLayoutStore {
  get(atom: typeof splitLayoutAtom): SplitLayout | null;
  set(atom: typeof splitLayoutAtom, value: SplitLayout): void;
}

export function openPaneContentInSplit(args: {
  store: SplitLayoutStore;
  navigate: (
    route: string,
    options?: { replace?: boolean; state?: NavigateState },
  ) => void | Promise<void>;
  content: PaneContent;
  route: string;
  enabled: boolean;
  state?: NavigateState;
}): void {
  const { store, content, route, state } = args;
  const withState = state === undefined ? {} : { state };
  const layout = store.get(splitLayoutAtom);
  if (!args.enabled || layout === null) {
    void args.navigate(route, state === undefined ? undefined : withState);
    return;
  }
  const existing = findPaneByContent(layout.root, content);
  const next =
    existing !== null
      ? setFocus(layout, existing.paneId)
      : countPanes(layout.root) >= MAX_PANES
        ? replacePaneContent(layout, layout.focusedPaneId, content)
        : splitPane(layout, layout.focusedPaneId, "right", content);
  if (next !== layout) store.set(splitLayoutAtom, next);
  void args.navigate(
    route,
    existing !== null
      ? { replace: true, ...withState }
      : state === undefined
        ? undefined
        : withState,
  );
}

export function openThreadInSplit(
  args: Pick<
    Parameters<typeof openPaneContentInSplit>[0],
    "store" | "navigate" | "state"
  > &
    ThreadRoutePathArgs,
): void {
  const { projectId, threadId } = args;
  openPaneContentInSplit({
    ...args,
    content: { kind: "thread", projectId, threadId },
    route: getThreadRoutePath({ projectId, threadId }),
    enabled: true,
  });
}
