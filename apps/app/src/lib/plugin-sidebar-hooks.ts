import { useMemo } from "react";
import { useAtomValue, useStore } from "jotai";
import {
  getThreadListIndicatorLabel,
  isThreadRead,
  resolveThreadListIndicator,
  threadListIndicatorStateForThread,
} from "@bb/client-core";
import {
  PERSONAL_PROJECT_ID,
  type Host,
  type ThreadListEntry,
} from "@bb/domain";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import type {
  PluginAppHost,
  PluginSidebarSplitLayout,
  PluginSidebarThread,
  PluginSidebarThreadActions,
  PluginSidebarThreadDraftState,
  PluginSidebarThreadSplit,
  PluginSidebarThreadsState,
  ShortcutHint,
  SidebarNavigationState,
} from "@bb/plugin/app";
import { getThreadConversationCollapsedAtom } from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import { useSidebarNavigationModel } from "@/components/sidebar/SidebarNavigationModel";
import { usePaneContentSplitPanes } from "@/components/sidebar/paneContentSplitIndicator";
import { useSidebarThreadShortcut as useHostSidebarThreadShortcut } from "@/components/sidebar/sidebarThreadShortcuts";
import { useThreadActions } from "@/components/thread/ThreadActionsProvider";
import {
  resolveThreadTitleDisplayText,
  useThreadTitleMentionResources,
  type ThreadTitleMentionResources,
} from "@/components/thread/ThreadTitleMentions";
import { useRouteNavigate } from "@/components/ui/app-route-anchor";
import {
  usePinThread,
  useUnpinThread,
  useUpdateThread,
} from "@/hooks/mutations/thread-state-mutations";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSidebarNavigation as useSidebarNavigationQuery } from "@/hooks/queries/sidebar-navigation-query";
import { useArchivedThreads } from "@/hooks/queries/thread-queries";
import {
  usePromptDraftHasInput,
  usePromptDraftInputThreadIds,
} from "@/hooks/usePromptDraftStorage";
import { useSetRootComposeProjectId } from "./root-compose-selection";
import {
  getProjectComposeRoutePath,
  getRootComposeRoutePath,
  getSettingsProjectRoutePath,
  getThreadRoutePath,
} from "./route-paths";
import {
  computePaneRects,
  countPanes,
  listPanes,
  type PaneContent,
} from "./split-layout";
import { openThreadInSplit, splitLayoutAtom } from "./split-layout/atoms";
import { getThreadDisplayTitle } from "./thread-title";

type HostNames = ReadonlyMap<string, string>;
type Entries = ReadonlyMap<string, ThreadListEntry>;
type NavigationData = ReturnType<typeof useSidebarNavigationQuery>["data"];

const NONE: readonly never[] = [];
const NO_ENTRIES: Entries = new Map();
const NO_HOST_NAMES: HostNames = new Map();

function toPluginSidebarThread(
  entry: ThreadListEntry,
  hostNames: HostNames,
  titleResources: ThreadTitleMentionResources,
): PluginSidebarThread {
  const indicator = resolveThreadListIndicator(
    threadListIndicatorStateForThread(entry, false),
  );
  const { activity, environmentHostId: hostId, runtime, ...shared } = entry;
  return {
    ...shared,
    displayTitle: resolveThreadTitleDisplayText(
      getThreadDisplayTitle(entry),
      titleResources,
    ),
    runtimeStatus: runtime.displayStatus,
    activity: {
      workflows: activity.activeWorkflowCount,
      backgroundAgents: activity.activeBackgroundAgentCount,
      backgroundCommands: activity.activeBackgroundCommandCount,
      goals: activity.activeGoalCount,
    },
    indicator,
    indicatorLabel: getThreadListIndicatorLabel(indicator),
    isUnread: !isThreadRead(entry),
    isPinned: entry.pinnedAt !== null,
    isArchived: entry.archivedAt !== null,
    href: getThreadRoutePath({
      projectId: entry.projectId,
      threadId: entry.id,
    }),
    isHidden: entry.visibility === "hidden",
    environment:
      entry.environmentId === null
        ? null
        : {
            id: entry.environmentId,
            name: entry.environmentName,
            branchName: entry.environmentBranchName,
            path: entry.environmentPath,
            isWorktree: entry.environmentIsWorktree,
            providerId: entry.environmentProviderId,
            workspaceDisplayKind: entry.environmentWorkspaceDisplayKind,
          },
    host:
      hostId === null
        ? null
        : { id: hostId, name: hostNames.get(hostId) ?? hostId },
  };
}

const hostNamesByHosts = new WeakMap<readonly Host[], HostNames>();

function hostNamesFor(hosts: readonly Host[] | undefined): HostNames {
  if (hosts === undefined) return NO_HOST_NAMES;
  let names = hostNamesByHosts.get(hosts);
  if (names === undefined) {
    names = new Map(hosts.map((host) => [host.id, host.name]));
    hostNamesByHosts.set(hosts, names);
  }
  return names;
}

const threadByEntry = new WeakMap<
  ThreadListEntry,
  { key: readonly unknown[]; thread: PluginSidebarThread }
>();

export function useSidebarThreads(
  options?: Parameters<PluginAppHost["useSidebarThreads"]>[0],
): PluginSidebarThreadsState {
  const lifecycles = options?.lifecycles;
  const active = !lifecycles?.length || lifecycles.includes("active");
  const includeArchived = lifecycles?.includes("archived") ?? false;
  const archived = useArchivedThreads({ enabled: includeArchived });
  const { fetchNextPage } = archived;
  const archivedStatus =
    archived.data !== undefined
      ? "ready"
      : archived.isLoadingError
        ? "error"
        : "loading";
  const archiveState = useMemo<PluginSidebarThreadsState["archived"]>(
    () =>
      includeArchived
        ? {
            status: archivedStatus,
            hasNextPage: archived.hasNextPage,
            isFetchingNextPage: archived.isFetchingNextPage,
            isFetchNextPageError: archived.isFetchNextPageError,
            fetchNextPage: async () => void (await fetchNextPage()),
          }
        : null,
    [
      includeArchived,
      archivedStatus,
      archived.hasNextPage,
      archived.isFetchingNextPage,
      archived.isFetchNextPageError,
      fetchNextPage,
    ],
  );
  const query = useSidebarNavigationQuery();
  const { data } = query;
  const { data: hosts } = useHosts();
  const hostNames = hostNamesFor(hosts);
  const titleResources = useThreadTitleMentionResources();
  return useMemo<PluginSidebarThreadsState>(() => {
    if (data === undefined) {
      return {
        archived: archiveState,
        status: query.isError ? "error" : "loading",
        threads: NONE,
        hosts: hosts ?? [],
        projects: NONE,
        sections: NONE,
      };
    }
    const projects = [...data.projects, data.personalProject];
    const selected = new Map<string, ThreadListEntry>();
    for (const thread of includeArchived
      ? (archived.data?.pages.flat() ?? [])
      : []) {
      if (thread.archivedAt !== null) selected.set(thread.id, thread);
    }
    for (const project of active ? projects : []) {
      for (const thread of project.threads) {
        if (thread.archivedAt === null) selected.set(thread.id, thread);
      }
    }
    return {
      archived: archiveState,
      status: !active && archiveState !== null ? archiveState.status : "ready",
      threads: [...selected.values()].map((entry) => {
        const cached = threadByEntry.get(entry);
        if (cached?.key[0] === hostNames && cached.key[1] === titleResources)
          return cached.thread;
        const thread = toPluginSidebarThread(entry, hostNames, titleResources);
        threadByEntry.set(entry, { key: [hostNames, titleResources], thread });
        return thread;
      }),
      hosts: hosts ?? [],
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        isPersonal: project.id === PERSONAL_PROJECT_ID,
        href: getProjectComposeRoutePath(project.id),
        settingsHref: getSettingsProjectRoutePath(project.id),
      })),
      sections: data.sections,
    };
  }, [
    data,
    hostNames,
    hosts,
    query.isError,
    titleResources,
    active,
    includeArchived,
    archived.data,
    archiveState,
  ]);
}

const entriesByData = new WeakMap<
  NonNullable<NavigationData>,
  { archived: unknown; entries: Entries }
>();

function useThreadEntryMap(): Entries {
  const { data } = useSidebarNavigationQuery();
  const archived = useArchivedThreads({ enabled: false }).data;
  if (data === undefined) return NO_ENTRIES;
  const cached = entriesByData.get(data);
  if (cached && cached.archived === archived) return cached.entries;
  const threads = [
    ...(archived?.pages.flat() ?? []),
    ...[...data.projects, data.personalProject].flatMap(
      (project) => project.threads,
    ),
  ];
  const entries = new Map(threads.map((thread) => [thread.id, thread]));
  entriesByData.set(data, { archived, entries });
  return entries;
}

export function useSidebarThreadEntry(
  threadId: string,
): ThreadListEntry | null {
  return useThreadEntryMap().get(threadId) ?? null;
}

export function useSidebarThreadActions(): PluginSidebarThreadActions {
  const navigate = useRouteNavigate();
  const store = useStore();
  const isCompact = useIsCompactViewport();
  const setRootComposeProjectId = useSetRootComposeProjectId();
  const hostActions = useThreadActions();
  const entries = useThreadEntryMap();
  const { mutateAsync: pinThread } = usePinThread();
  const { mutateAsync: unpinThread } = useUnpinThread();
  const { mutateAsync: updateThread } = useUpdateThread();
  return useMemo<PluginSidebarThreadActions>(() => {
    const requireEntry = (threadId: string): ThreadListEntry => {
      const entry = entries.get(threadId);
      if (entry === undefined) throw new Error(`Unknown thread: ${threadId}`);
      return entry;
    };
    return {
      open(threadId, options) {
        const projectId = entries.get(threadId)?.projectId;
        if (projectId === undefined) return;
        store.set(getThreadConversationCollapsedAtom(threadId), false);
        if (options?.split)
          openThreadInSplit({
            store,
            navigate,
            projectId,
            threadId,
            isCompact,
          });
        else navigate(getThreadRoutePath({ projectId, threadId }));
      },
      openNewThread(options = {}) {
        const { projectId, sectionId, environmentId } = options;
        const hostId = options.hostId?.trim();
        if (projectId !== undefined) setRootComposeProjectId(projectId);
        navigate(getRootComposeRoutePath(), {
          state: {
            placement: options.placement ?? {
              sectionId: sectionId ?? null,
              pinned: false,
            },
            ...(options.focusPrompt ? { focusPrompt: true } : {}),
            ...(sectionId === undefined ? {} : { sectionId }),
            ...(environmentId === undefined
              ? {}
              : { reuseEnvironmentId: environmentId }),
            ...(hostId ? { newEnvironmentHostId: hostId } : {}),
          },
        });
      },
      async setPinned(threadId, pinned) {
        if ((requireEntry(threadId).pinnedAt !== null) === pinned) return;
        await (pinned ? pinThread : unpinThread)({ id: threadId });
      },
      async setRead(threadId, read) {
        const entry = requireEntry(threadId);
        if (isThreadRead(entry) !== read) hostActions.toggleRead(entry);
      },
      async rename(threadId, title) {
        await updateThread({ id: threadId, title });
      },
      archive: (threadId) => hostActions.requestArchive(requireEntry(threadId)),
      requestDelete: (threadId) =>
        hostActions.requestDelete(requireEntry(threadId)),
    };
  }, [
    entries,
    hostActions,
    isCompact,
    navigate,
    pinThread,
    setRootComposeProjectId,
    store,
    unpinThread,
    updateThread,
  ]);
}

const NO_DRAFT: PluginSidebarThreadDraftState = { hasUnsubmittedDraft: false };
const HAS_DRAFT: PluginSidebarThreadDraftState = { hasUnsubmittedDraft: true };
const NO_DRAFT_IDS: ReadonlySet<string> = new Set();

export function useSidebarThreadDraft(
  threadId: string,
): PluginSidebarThreadDraftState {
  const entry = useSidebarThreadEntry(threadId);
  const hasDraft = usePromptDraftHasInput({
    kind: "thread",
    projectId: entry?.projectId ?? "",
    threadId,
  });
  return entry !== null && hasDraft ? HAS_DRAFT : NO_DRAFT;
}

export function useSidebarThreadDraftIds(): ReadonlySet<string> {
  const entries = useThreadEntryMap();
  const refs = useMemo(() => [...entries.values()], [entries]);
  const ids = usePromptDraftInputThreadIds(refs);
  return ids.size === 0 ? NO_DRAFT_IDS : ids;
}

export function useSidebarThreadShortcut(
  threadId: string,
): ShortcutHint | null {
  return useHostSidebarThreadShortcut(threadId) ?? null;
}

export function useSidebarSplitLayout(): PluginSidebarSplitLayout | null {
  const isCompact = useIsCompactViewport();
  const layout = useAtomValue(splitLayoutAtom);
  return useMemo(() => {
    if (isCompact || layout === null || countPanes(layout.root) < 2)
      return null;
    const rects = computePaneRects(layout.root);
    return {
      panes: listPanes(layout.root).flatMap(({ paneId, content }) => {
        const rect = rects.get(paneId);
        return rect === undefined
          ? []
          : {
              paneId,
              rect: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
              threadId: content.kind === "thread" ? content.threadId : null,
              isFocused: paneId === layout.focusedPaneId,
            };
      }),
    };
  }, [isCompact, layout]);
}

function useSplit(content: PaneContent | null): PluginSidebarThreadSplit {
  const isCompact = useIsCompactViewport();
  const panes = usePaneContentSplitPanes(isCompact ? null : content);
  return useMemo(
    () => ({
      isAvailable: content !== null && !isCompact,
      layout: panes === null ? null : { panes },
    }),
    [content, isCompact, panes],
  );
}

export function useSidebarThreadSplit(
  threadId: string,
): PluginSidebarThreadSplit {
  const projectId = useSidebarThreadEntry(threadId)?.projectId ?? null;
  const content = useMemo<PaneContent | null>(
    () => (projectId === null ? null : { kind: "thread", projectId, threadId }),
    [projectId, threadId],
  );
  return useSplit(content);
}

const EMPTY_NAVIGATION: SidebarNavigationState = {
  items: [],
  activeItemId: null,
  isShortcutModifierHeld: false,
  actions: { activate() {}, disablePlugin: () => Promise.resolve() },
};

export function useSidebarNavigation(): SidebarNavigationState {
  const state = useSidebarNavigationModel()?.state ?? EMPTY_NAVIGATION;
  const { items, activeItemId, isShortcutModifierHeld, actions } = state;
  return useMemo(
    () => ({ items, activeItemId, isShortcutModifierHeld, actions }),
    [items, activeItemId, isShortcutModifierHeld, actions],
  );
}

export function useSidebarNavigationSplit(
  itemId: string,
): PluginSidebarThreadSplit {
  const entry = useSidebarNavigationModel()?.entries.find(
    (candidate) => candidate.item.id === itemId,
  );
  return useSplit(entry?.content ?? null);
}
