import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  threadTabSchema,
  type TerminalSession,
  type ThreadTab,
  type ThreadTabsResponse,
} from "@bb/server-contract";
import type { HostFileTabState, WorkspaceFileTabState } from "@bb/client-core";
import { appToast } from "@/components/ui/app-toast";
import { threadTabsQueryKey } from "@/hooks/queries/query-keys";
import { BbHttpError, sdk } from "@/lib/sdk";
import { isVisibleTerminalSession } from "@/lib/terminal-session-visibility";

type PanelTabKind =
  | "plugin-panel"
  | "workspace-file-preview"
  | "host-file-preview"
  | "new-tab"
  | "terminal";
export type PanelTab = Extract<ThreadTab, { kind: PanelTabKind }>;

export interface PanelState {
  tabs: readonly PanelTab[];
  activeTabId: string | null;
  isOpen: boolean;
  previousTabId?: string | null;
}

export type PanelStateChange = (state: PanelState) => PanelState;

interface PluginPanelTabArgs {
  pluginId: string;
  actionId: string;
  title: string;
  paramsJson: string | null;
}

const PANEL_TAB_KINDS: ReadonlySet<string> = new Set<PanelTabKind>([
  "plugin-panel",
  "workspace-file-preview",
  "host-file-preview",
  "new-tab",
  "terminal",
]);
const STORAGE_PREFIX = "bb.thread.fixedPanelTabsState-";
const IDLE_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;
const NO_FIXED_IDS: readonly string[] = [];
const EMPTY_STATE: PanelState = { tabs: [], activeTabId: null, isOpen: false };
const DEFAULT_OPEN_STATE: PanelState = { ...EMPTY_STATE, isOpen: true };

export const THREAD_INFO_TAB_ID = "thread-info:thread-info:none";
export const GIT_DIFF_TAB_ID = "git-diff:git-diff:none";
export const NEW_TAB: PanelTab = {
  id: "new-tab:new-tab:none",
  kind: "new-tab",
};

export function panelTabId(
  kind: string,
  path: string,
  scope: string | null = null,
): string {
  return [kind, path, scope ?? "none"].map(encodeURIComponent).join(":");
}

export function workspaceFileTab(
  file: WorkspaceFileTabState,
  environmentId: string | null,
  projectId: string | null,
): PanelTab {
  return {
    ...file,
    kind: "workspace-file-preview",
    environmentId,
    projectId,
    id: panelTabId(
      "workspace-file-preview",
      file.path,
      environmentId ?? (projectId === null ? null : `project:${projectId}`),
    ),
  };
}

export function hostFileTab(
  file: HostFileTabState,
  environmentId: string,
  threadId: string,
): PanelTab {
  return {
    ...file,
    kind: "host-file-preview",
    environmentId,
    hostId: null,
    threadId,
    id: panelTabId(
      "host-file-preview",
      file.path,
      `thread:${threadId}:environment:${environmentId}`,
    ),
  };
}

export function terminalTab(terminalId: string): PanelTab {
  return {
    id: panelTabId("terminal", terminalId),
    kind: "terminal",
    terminalId,
  };
}

export function pluginPanelTab(args: PluginPanelTabArgs): PanelTab {
  return {
    ...args,
    kind: "plugin-panel",
    id: panelTabId(
      "plugin-panel",
      `${args.pluginId}:${args.actionId}:${args.paramsJson ?? ""}`,
    ),
  };
}

function parseTabs(value: unknown): PanelTab[] {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    const tab = threadTabSchema.safeParse(item).data;
    if (
      tab === undefined ||
      !PANEL_TAB_KINDS.has(tab.kind) ||
      tab.kind === "new-tab" ||
      (tab.kind === "plugin-panel" && tab.fileOpenerOwner !== undefined) ||
      seen.has(tab.id)
    ) {
      return [];
    }
    seen.add(tab.id);
    return [tab as PanelTab];
  });
}

function persistedTabs(tabs: readonly PanelTab[]): PanelTab[] {
  return tabs.filter((tab) => tab.kind !== "new-tab");
}

function syncedTabs(tabs: readonly PanelTab[]): PanelTab[] {
  return tabs.filter(
    (tab) => tab.kind !== "new-tab" && tab.kind !== "terminal",
  );
}

function tabsKey(tabs: readonly PanelTab[]): string {
  return JSON.stringify(
    tabs.map((tab) =>
      Object.entries(tab)
        .filter(([, value]) => value !== null && value !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : 1)),
    ),
  );
}

const states = new Map<string, PanelState>();
const listeners = new Set<() => void>();
const pendingPushes = new Map<string, Promise<void>>();

function storageKey(panelId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(panelId.trim())}-1`;
}

function writePanelState(panelId: string, state: PanelState): void {
  states.set(panelId, state);
  try {
    window.localStorage.setItem(
      storageKey(panelId),
      JSON.stringify({
        version: 1,
        secondary: {
          tabs: persistedTabs(state.tabs),
          activeTabId: state.activeTabId,
          isOpen: state.isOpen,
        },
        lastUsedAt: Date.now(),
      }),
    );
  } catch {}
  listeners.forEach((listener) => listener());
}

function readPanelState(panelId: string, initial: PanelState): PanelState {
  const cached = states.get(panelId);
  if (cached !== undefined) return cached;
  let state = initial;
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(storageKey(panelId)) ?? "null",
    );
    const age = Date.now() - stored?.lastUsedAt;
    if (stored?.version === 1 && age < IDLE_EXPIRY_MS) {
      const activeTabId = stored.secondary.activeTabId;
      state = {
        tabs: parseTabs(stored.secondary.tabs),
        activeTabId: typeof activeTabId === "string" ? activeTabId : null,
        isOpen: stored.secondary.isOpen === true,
      };
      if (age > TOUCH_AFTER_MS) writePanelState(panelId, state);
    }
  } catch {}
  states.set(panelId, state);
  return state;
}

function pruneIdlePanelStates(): void {
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (!key.startsWith(STORAGE_PREFIX)) continue;
      const stored = JSON.parse(window.localStorage.getItem(key) ?? "null");
      if (!(Date.now() - stored?.lastUsedAt < IDLE_EXPIRY_MS)) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {}
}
if (typeof window !== "undefined") {
  window.setTimeout(pruneIdlePanelStates, 5_000);
}

function settlePanelState(
  state: PanelState,
  fixedIds: readonly string[],
): PanelState {
  if (!state.isOpen) return state;
  const ids = [...fixedIds, ...state.tabs.map((tab) => tab.id)];
  if (state.activeTabId !== null && ids.includes(state.activeTabId)) {
    return state;
  }
  const activeTabId = ids[0] ?? null;
  return { ...state, activeTabId, isOpen: activeTabId !== null };
}

function pushThreadTabs(queryClient: QueryClient, threadId: string): void {
  const queryKey = threadTabsQueryKey(threadId);
  const run = async () => {
    for (let attempt = 0; ; attempt += 1) {
      await queryClient.cancelQueries({ queryKey });
      const current =
        queryClient.getQueryData<ThreadTabsResponse>(queryKey) ??
        (await sdk.threads.tabs.get({ threadId }));
      const tabs = syncedTabs(states.get(threadId)?.tabs ?? []);
      if (tabsKey(syncedTabs(parseTabs(current.tabs))) === tabsKey(tabs)) {
        return;
      }
      try {
        queryClient.setQueryData(
          queryKey,
          await sdk.threads.tabs.update({
            expectedRevision: current.revision,
            tabs,
            threadId,
          }),
        );
        return;
      } catch (error) {
        const isConflict = error instanceof BbHttpError && error.status === 409;
        if (attempt > 0 || !isConflict) throw error;
        queryClient.setQueryData(
          queryKey,
          await sdk.threads.tabs.get({ threadId }),
        );
      }
    }
  };
  const push = (pendingPushes.get(threadId) ?? Promise.resolve())
    .then(run)
    .catch((error: unknown) => {
      appToast.error("Couldn’t sync tabs", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
      void queryClient.invalidateQueries({ queryKey });
    })
    .finally(() => {
      if (pendingPushes.get(threadId) === push) pendingPushes.delete(threadId);
    });
  pendingPushes.set(threadId, push);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

interface UsePanelTabsArgs {
  panelId: string | null;
  synced?: boolean;
  fixedIds?: readonly string[];
  ready?: boolean;
  defaultOpen?: boolean;
}

export function usePanelTabs({
  panelId,
  synced = false,
  fixedIds = NO_FIXED_IDS,
  ready = true,
  defaultOpen = false,
}: UsePanelTabsArgs) {
  const queryClient = useQueryClient();
  const initial = defaultOpen ? DEFAULT_OPEN_STATE : EMPTY_STATE;
  const state = useSyncExternalStore(subscribe, () =>
    panelId === null ? EMPTY_STATE : readPanelState(panelId, initial),
  );
  const fixedIdsRef = useRef(fixedIds);
  fixedIdsRef.current = fixedIds;
  const fixedIdsKey = fixedIds.join("\n");
  const syncThreadId = synced ? panelId : null;

  const commit = useCallback(
    (change: PanelStateChange, push: boolean) => {
      if (panelId === null) return;
      const current = readPanelState(panelId, initial);
      const changed = change(current);
      let next = ready
        ? settlePanelState(changed, fixedIdsRef.current)
        : changed;
      if (
        next.tabs === current.tabs &&
        next.activeTabId === current.activeTabId &&
        next.isOpen === current.isOpen
      ) {
        return;
      }
      if (
        next.activeTabId !== current.activeTabId &&
        current.activeTabId !== NEW_TAB.id
      ) {
        next = { ...next, previousTabId: current.activeTabId };
      }
      writePanelState(panelId, next);
      if (
        push &&
        syncThreadId !== null &&
        tabsKey(syncedTabs(next.tabs)) !== tabsKey(syncedTabs(current.tabs))
      ) {
        pushThreadTabs(queryClient, syncThreadId);
      }
    },
    [initial, panelId, queryClient, ready, syncThreadId],
  );
  const update = useCallback(
    (change: PanelStateChange) => commit(change, true),
    [commit],
  );

  useEffect(() => {
    commit((current) => current, false);
  }, [commit, fixedIdsKey]);

  const serverTabs = useQuery<ThreadTabsResponse>({
    queryKey: threadTabsQueryKey(syncThreadId ?? ""),
    queryFn: ({ signal }) =>
      sdk.threads.tabs.get({ threadId: syncThreadId ?? "", signal }),
    enabled: syncThreadId !== null,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  }).data;
  useEffect(() => {
    if (
      syncThreadId === null ||
      serverTabs === undefined ||
      pendingPushes.has(syncThreadId)
    ) {
      return;
    }
    const tabs = syncedTabs(parseTabs(serverTabs.tabs));
    commit((current) => {
      const synced = syncedTabs(current.tabs);
      return tabsKey(synced) === tabsKey(tabs)
        ? current
        : {
            ...current,
            tabs: [
              ...tabs,
              ...current.tabs.filter((tab) => !synced.includes(tab)),
            ],
          };
    }, false);
  }, [commit, serverTabs, syncThreadId]);

  const activate = useCallback(
    (tabId: string) =>
      update((current) => ({ ...current, activeTabId: tabId, isOpen: true })),
    [update],
  );
  const open = useCallback(
    (tab: PanelTab, replaceNewTab = false) =>
      update((current) => {
        const existing = current.tabs.find((item) => item.id === tab.id);
        let tabs = current.tabs;
        if (existing === undefined) {
          const slot = replaceNewTab
            ? tabs.findIndex((item) => item.kind === "new-tab")
            : -1;
          tabs =
            slot < 0
              ? [...tabs, tab]
              : tabs.map((item, index) => (index === slot ? tab : item));
        } else {
          if (tabsKey([existing]) !== tabsKey([tab])) {
            tabs = tabs.map((item) => (item === existing ? tab : item));
          }
          if (replaceNewTab && tabs.some((item) => item.kind === "new-tab")) {
            tabs = tabs.filter((item) => item.kind !== "new-tab");
          }
        }
        return { ...current, tabs, activeTabId: tab.id, isOpen: true };
      }),
    [update],
  );
  const close = useCallback(
    (tabId: string) =>
      update((current) => {
        const index = current.tabs.findIndex((tab) => tab.id === tabId);
        if (index < 0) return current;
        const tabs = current.tabs.filter((tab) => tab.id !== tabId);
        const previous = current.previousTabId ?? null;
        const neighbor = (tabs[index] ?? tabs[index - 1])?.id ?? null;
        const canReturn =
          previous !== null &&
          previous !== tabId &&
          (fixedIdsRef.current.includes(previous) ||
            tabs.some((tab) => tab.id === previous));
        return {
          ...current,
          tabs,
          activeTabId:
            current.activeTabId !== tabId
              ? current.activeTabId
              : canReturn
                ? previous
                : neighbor,
        };
      }),
    [update],
  );
  const setOpen = useCallback(
    (isOpen: boolean) => update((current) => ({ ...current, isOpen })),
    [update],
  );

  return {
    state,
    isOpen: state.isOpen,
    activeTabId: state.activeTabId,
    activeTab: state.tabs.find((tab) => tab.id === state.activeTabId) ?? null,
    isSynced: syncThreadId === null || serverTabs !== undefined,
    activate,
    close,
    open,
    setOpen,
    update,
  };
}

export function useTerminalTabSync(
  update: (change: PanelStateChange) => void,
  terminalSessions: readonly TerminalSession[] | undefined,
): void {
  useEffect(() => {
    if (terminalSessions === undefined) return;
    const liveIds = terminalSessions
      .filter(isVisibleTerminalSession)
      .map((session) => session.id);
    update((current) => {
      const tabs = current.tabs.filter(
        (tab) => tab.kind !== "terminal" || liveIds.includes(tab.terminalId),
      );
      const added = liveIds
        .filter(
          (id) =>
            !tabs.some(
              (tab) => tab.kind === "terminal" && tab.terminalId === id,
            ),
        )
        .map(terminalTab);
      return tabs.length === current.tabs.length && added.length === 0
        ? current
        : { ...current, tabs: [...tabs, ...added] };
    });
  }, [terminalSessions, update]);
}
