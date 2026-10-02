import {
  appendQuoteAndAttachmentsToDraft,
  getFilePreviewLineRangeStart,
  isSecondaryFileTab,
  type PromptDraftAttachment,
  type WorkspaceFileTabState,
} from "@bb/client-core";
import { createCoreComposerActions } from "@/lib/plugin-composer-handle";
import {
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useImmediateRouteNavigate } from "@/components/ui/app-route-anchor";
import { useAtom } from "jotai";
import {
  isRunningThreadRuntimeDisplayStatus,
  type ThreadTimelineLocalFileLink,
  type ThreadTimelineOpenPluginPanelHandler,
  useThreadTimelineController,
} from "@/components/thread/timeline";
import { serializePluginPanelParams } from "@/lib/plugin-json-value";
import {
  defaultAppSettings,
  resolveEnvironmentMergeBaseBranch,
  type ThreadListEntry,
} from "@bb/domain";
import { appToast } from "@/components/ui/app-toast";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import type { ThreadSecondaryPanel as ThreadSecondaryPanelTab } from "@/lib/thread-secondary-panel";
import {
  useRequestEnvironmentAction,
  useUpdateEnvironment,
} from "../../hooks/mutations/environment-mutations";
import {
  useMarkThreadRead,
  useUpdateThread,
} from "../../hooks/mutations/thread-state-mutations";
import { useSendThreadMessage } from "../../hooks/mutations/thread-runtime-mutations";
import {
  useEnvironment,
  useEnvironmentWorkStatus,
} from "../../hooks/queries/environment-queries";
import { useChildThreadPendingAttention } from "../../hooks/queries/child-thread-pending-interactions";
import {
  didThreadDetailBootstrapRefreshAfterMount,
  getLatestPendingInteraction,
  isPendingInteractionStateUnknown,
  useChildThreads,
  useProjectThreadSubset,
  useThread,
  useThreadDetailBootstrap,
  useThreadPendingInteractions,
  useThreadStorageLocation,
} from "../../hooks/queries/thread-queries";
import { isTransientReadError } from "@/hooks/queries/query-helpers";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { subscribeComposerFocusRequests } from "@/lib/composer-focus-requests";
import { ThreadGitActionDialog } from "@/components/dialogs/ThreadGitActionDialog";
import { PageShell } from "@/components/ui/page-shell.js";
import { RouteLoadingSkeleton } from "@/components/ui/route-loading-skeleton";
import { HEADER_ICON_BUTTON_CLASS } from "@/components/layout/AppPageHeader";
import { ThreadActionsMenu } from "@/components/thread/ThreadActionsMenu";
import { useThreadActions } from "@/components/thread/ThreadActionsProvider";
import { ThreadWorkspaceOpenButton } from "@/components/thread/ThreadWorkspaceOpenButton";
import { formatEnvironmentDisplay } from "@bb/core-ui";
import { useCreateThreadInEnvironment } from "@/hooks/useCreateThreadInEnvironment";
import { useLocalHostId, useOpenTargets } from "@/hooks/useOpenTargets";
import { selectHosts, useHosts } from "@/hooks/queries/host-queries";
import { useConnectionAwareQueryState } from "@/hooks/queries/connection-aware-query-state";
import {
  useCloseThreadTerminal,
  useCreateThreadTerminal,
  useThreadTerminals,
} from "@/hooks/queries/thread-terminal-queries";
import {
  findEnvironmentDisplayProvider,
  getEnvironmentSummaryChrome,
  isHostAmbiguous,
} from "@/lib/environment-workspace-display";
import { useSystemEnvironmentProviders } from "@/hooks/queries/environment-provider-queries";
import { formatWorkspaceCheckoutDisplay } from "@/lib/workspace-checkout-display";
import {
  getAbsoluteDirname,
  isAbsoluteFilePathWithinRoot,
  resolveAbsoluteFilePath,
} from "@/lib/absolute-file-path";
import { getGitStatusDisplay } from "@/components/workspace/workspace-status";
import {
  selectWorkspaceChangedFilesSection,
  type WorkspaceChangedFileSelection,
} from "@/components/workspace/workspace-change-summary";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { hasThreadProvisioningFailure } from "@/lib/thread-provisioning-failure";
import {
  getProjectComposeRoutePath,
  getThreadRoutePath,
  type ThreadRoutePathArgs,
} from "@/lib/route-paths";
import { useGitDiffPanel } from "@/components/secondary-panel/git-diff/useGitDiffPanel";
import { ThreadDetailHeader } from "./ThreadDetailHeader";
import { ThreadDetailPromptArea } from "./ThreadDetailPromptArea";
import { isThreadDisplayStatusBannerActive } from "@/components/promptbox/banner/ThreadPromptContextBanner";
import { ThreadDetailSecondaryContent } from "./ThreadDetailSecondaryContent";
import {
  shouldLoadThreadStorageFileList,
  useThreadStorageViewer,
} from "@/components/secondary-panel/useThreadStorageViewer";
import { getThreadConversationCollapsedAtom } from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import { LazyThreadTerminalPanel } from "@/components/secondary-panel/lazySecondaryPanelComponents";
import { NewTabPage } from "@/components/secondary-panel/NewTabPage";
import {
  HostFilePreviewTabContent,
  ThreadStorageFilePreviewTabContent,
  WorkspaceFilePreviewTabContent,
} from "@/components/secondary-panel/ThreadSecondaryPanelTabContent";
import { RightPanelFileTabIcon } from "@/components/secondary-panel/RightPanelFileTabIcon";
import { COARSE_POINTER_COMPACT_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { PluginItemIcon } from "@/components/plugin/PluginIcon";
import {
  PluginPanelTabContent,
  usePluginPanelActions,
} from "@/components/plugin/PluginPanelActions";
import {
  PluginThreadPanelNavigationProvider,
  usePublishThreadPanelOpener,
} from "@/components/plugin/plugin-thread-panel-navigation";
import { ThreadTimelineNavigationProvider } from "@/components/thread/timeline/ThreadTimelineNavigationContext";
import { usePluginSlots } from "@/plugins/registry";
import { Icon } from "@bb/shared-ui/icon";
import { openHttpUrlInExternalBrowser } from "@/lib/url-open-routing";
import { getFileBasename } from "@/lib/live-file-navigation";
import { useThreadStorageBrowser } from "@/components/secondary-panel/useThreadStorageBrowser";
import { useThreadFileTabs } from "@/components/secondary-panel/useThreadFileTabs";
import { useThreadOpenFileSignal } from "@/components/secondary-panel/useThreadOpenFileSignal";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import type {
  SecondaryPanelFixedTab,
  SecondaryPanelRenderableTab,
} from "@/components/secondary-panel/ThreadSecondaryPanel";
import { useEnvironmentMergeBase } from "@/components/secondary-panel/git-diff/useEnvironmentMergeBase";
import { useThreadGitActions } from "./useThreadGitActions";
import { useThreadReadTracking } from "@/hooks/useThreadReadTracking";
import { useThreadUnreadDividerState } from "./useThreadUnreadDividerState";
import {
  buildTerminalSyncedSecondaryFileTabs,
  syncTerminalTabsInFixedPanelState,
} from "@/components/secondary-panel/terminalPanelTabs";
import {
  buildOpenInEditorHandler,
  resolveWorkspaceChangedFileOpenTarget,
} from "./threadWorkspaceOpenPath";
import { resolveThreadLocalFileLink } from "@/lib/thread-local-file-links";
import {
  MarkdownLocalFileContextMenuContext,
  type MarkdownLinkRouting,
  type MarkdownLocalFileContextMenuItem,
} from "@/components/ui/markdown-link-routing";
import {
  useFixedPanelTabsStorageMaintenance,
  useReconciledFixedPanelTabsState,
  useRemoveFixedRightTerminalTab,
  useSetFixedRightTerminalActiveTerminal,
  useTouchFixedPanelTabsState,
  useUpdateFixedPanelTabsState,
} from "@/lib/fixed-panel-tabs";
import {
  createGitDiffFixedPanelTab,
  createNewTabFixedPanelTab,
  createThreadInfoFixedPanelTab,
  type SecondaryFileFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import { resolveGitDiffTabStatus } from "@/components/secondary-panel/gitDiffTabEligibility";
import { isRootThread } from "./threadParentSelectorOptions";
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
} from "@/components/thread/terminal/useThreadTerminalController";
import {
  getActiveFixedSecondaryTab,
  useSetThreadSecondaryPanelSelection,
  useToggleThreadSecondaryPanelSelection,
} from "./threadSecondaryPanelSelection";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { usePaneContext } from "./PaneContext";

type ContentProps = ComponentProps<typeof ThreadDetailSecondaryContent>;
const NO_THREADS: readonly ThreadListEntry[] = [];
const NO_FILTERS = {};

function copyFileText(text: string, what: string): void {
  void copyToClipboardWithToast(text, {
    successMessage: `File ${what} copied`,
    errorMessage: `Failed to copy file ${what}`,
  });
}

export function ThreadDetailView({
  projectId,
  threadId,
  timelineEnabled,
}: ThreadRoutePathArgs & { timelineEnabled: boolean }) {
  const { isFocused, navigateInPane, isBoundedPane } = usePaneContext();
  const navigate = useImmediateRouteNavigate();
  const threadActions = useThreadActions();
  useFixedPanelTabsStorageMaintenance();
  const systemConfigQuery = useSystemConfig();
  const bootstrapQuery = useThreadDetailBootstrap(threadId);
  const bootstrapSettled = bootstrapQuery.isSuccess || bootstrapQuery.isError;
  const threadQuery = useThread(threadId, {
    enabled: bootstrapSettled,
    refetchOnMount: didThreadDetailBootstrapRefreshAfterMount(bootstrapQuery)
      ? false
      : "always",
  });
  const thread = threadQuery.data;
  const environmentQuery = useEnvironment(thread?.environmentId, {
    enabled: bootstrapSettled,
    staleTime: 5_000,
  });
  const environment = environmentQuery.data;
  const hostLifecycle =
    environment === undefined || environment.hostLifecycle === "active"
      ? null
      : environment.hostLifecycle;
  const executionUnavailable =
    hostLifecycle !== null || environment?.status === "destroyed";
  const gitDiffTabStatus = resolveGitDiffTabStatus({
    environmentId: thread?.environmentId ?? null,
    environmentIsGitRepo: environment?.isGitRepo,
    environmentLoadFailed: environmentQuery.isError,
    environmentOwnsPath: environment?.managed,
    hasResolvedThread: thread !== undefined,
    threadArchived: thread?.archivedAt != null || executionUnavailable,
  });
  const hasGitDiffTab = gitDiffTabStatus !== "ineligible";
  const fixedViewTabs = useMemo(
    () => [
      createThreadInfoFixedPanelTab(),
      ...(hasGitDiffTab ? [createGitDiffFixedPanelTab()] : []),
    ],
    [hasGitDiffTab],
  );
  const fixedPanelTabsState = useReconciledFixedPanelTabsState({
    fixedTabs: fixedViewTabs,
    isAuthoritative:
      gitDiffTabStatus === "eligible" || gitDiffTabStatus === "ineligible",
    panelStateId: threadId,
    syncThreadId: threadId,
  });
  const isPanelOpen = fixedPanelTabsState.secondary.isOpen;
  const activeTab = getActiveFixedSecondaryTab({ fixedPanelTabsState });
  const touchFixedPanelTabsState = useTouchFixedPanelTabsState(
    threadId,
    threadId,
  );
  const setActiveTerminal = useSetFixedRightTerminalActiveTerminal(
    threadId,
    threadId,
  );
  const removeTerminalTab = useRemoveFixedRightTerminalTab(threadId, threadId);
  const updateFixedPanelTabsState = useUpdateFixedPanelTabsState(
    threadId,
    threadId,
  );
  const setSecondaryPanel = useSetThreadSecondaryPanelSelection(
    threadId,
    threadId,
  );
  const togglePanel = useToggleThreadSecondaryPanelSelection(
    threadId,
    threadId,
  );
  const [autoFocusTerminal, setAutoFocusTerminal] = useState(false);
  const [autoFocusNewTab, setAutoFocusNewTab] = useState(false);
  const [mergeBaseOptionsRequested, setMergeBaseOptionsRequested] =
    useState(false);
  const threadQueryState = useConnectionAwareQueryState({
    hasResolvedData: thread !== undefined,
    isFetching: bootstrapQuery.isFetching || threadQuery.isFetching,
    isLoadingError: threadQuery.isLoadingError,
    isRecoverableLoadingError: isTransientReadError(threadQuery.error),
  });
  const isReady = threadQueryState.status === "ready" && thread !== undefined;
  const originKind = thread?.originKind ?? null;
  const sourceThreadId =
    thread?.sourceThreadId ??
    (thread && originKind ? thread.parentThreadId : null);
  const { data: parentThread } = useThread(thread?.parentThreadId ?? "");
  const { data: sourceThread } = useThread(sourceThreadId ?? "");
  const pendingInteractionsQuery = useThreadPendingInteractions(
    thread?.id ?? "",
    { enabled: isReady },
  );
  const pendingInteractions = pendingInteractionsQuery.data ?? [];
  const hasPendingInteraction =
    getLatestPendingInteraction(pendingInteractions) !== null;
  const unreadDividerState = useThreadUnreadDividerState({
    routeThreadId: threadId,
    thread,
  });
  const storage = useThreadStorageViewer({
    fileListEnabled: shouldLoadThreadStorageFileList({
      hasThread: thread !== undefined,
      isSecondaryPanelOpen: isPanelOpen,
      secondaryTabs: fixedPanelTabsState.secondary.tabs,
    }),
    threadId,
  });
  const storageRootPath =
    useThreadStorageLocation(threadId, {
      enabled: Boolean(thread?.environmentId),
    }).data?.storageRootPath ?? null;
  const terminalsQuery = useThreadTerminals(threadId, {
    enabled: isPanelOpen,
  });
  const terminalSessions = terminalsQuery.data?.sessions;
  const fileTabs = useThreadFileTabs({
    panelStateId: threadId,
    syncThreadId: threadId,
    environmentId: thread?.environmentId,
    storageFiles: storage.threadStorageFiles,
    terminalSessions,
  });
  const { closeTab, openTab, openPluginPanel } = fileTabs;
  const pluginPanelActions = usePluginPanelActions({
    openPluginPanel,
    threadId,
  });
  const { threadPanels: pluginThreadPanels } = usePluginSlots();
  useThreadOpenFileSignal({
    threadId,
    environmentId: thread?.environmentId,
    openTab,
  });
  const previewWorkspaceFile = (
    path: string,
    lineRange: WorkspaceFileTabState["lineRange"] = null,
    source: WorkspaceFileTabState["source"] = { kind: "working-tree" },
    statusLabel: WorkspaceFileTabState["statusLabel"] = null,
  ) =>
    openTab({
      kind: "workspace-file-preview",
      tab: { lineRange, path, source, statusLabel },
    });
  const previewStorageFile = (
    path: string,
    lineRange: WorkspaceFileTabState["lineRange"] = null,
  ) =>
    openTab({ kind: "thread-storage-file-preview", tab: { lineRange, path } });
  const isThreadRoot = isRootThread(thread);
  const [parentThreadsRequestedFor, setParentThreadsRequestedFor] = useState<
    string | null
  >(null);
  const loadsParentThreads =
    isReady && isThreadRoot && parentThreadsRequestedFor === thread.id;
  const parentThreadsQuery = useProjectThreadSubset({
    enabled: loadsParentThreads,
    filters: NO_FILTERS,
    projectId,
  });
  const childThreadsQuery = useChildThreads({
    enabled: isReady,
    parentThreadId: thread?.id,
  });
  const timeline = useThreadTimelineController({
    threadId,
    enabled: timelineEnabled,
  });
  const { timelineRows } = timeline;
  const isTimelinePending =
    timeline.timelineLoading && timelineRows.length === 0;
  const sendMessage = useSendThreadMessage();
  const requestEnvironmentAction = useRequestEnvironmentAction();
  const markThreadRead = useMarkThreadRead();
  const updateEnvironment = useUpdateEnvironment();
  const updateThread = useUpdateThread({
    errorMessage: "Failed to assign parent thread.",
  });
  const createTerminal = useCreateThreadTerminal();
  const closeTerminal = useCloseThreadTerminal();
  useEffect(() => {
    if (terminalSessions === undefined) return;
    updateFixedPanelTabsState((state) =>
      syncTerminalTabsInFixedPanelState({ state, terminalSessions }),
    );
  }, [terminalSessions, updateFixedPanelTabsState]);
  const hostsQuery = useHosts({
    enabled: bootstrapSettled && thread?.environmentId != null,
  });
  const hosts = hostsQuery.data ?? [];
  const environmentHost =
    hosts.find((host) => host.id === environment?.hostId) ?? null;
  const hasMultipleMachines =
    selectHosts(hostsQuery.data, "persistent").length > 1;
  const ambiguousHost = isHostAmbiguous(
    hasMultipleMachines,
    environmentHost?.type ?? null,
  )
    ? environmentHost
    : null;
  const draftProjectId = thread?.projectId ?? projectId;
  const draftThreadId = thread?.id ?? "";
  const promptDraft = useMemo(
    () =>
      getPromptDraftAccessor({
        kind: "thread",
        projectId: draftProjectId,
        threadId: draftThreadId,
      }),
    [draftProjectId, draftThreadId],
  );
  const [composerFocusNonce, setComposerFocusNonce] = useState(0);
  useEffect(
    () =>
      subscribeComposerFocusRequests(promptDraft.storageKey, () =>
        setComposerFocusNonce((nonce) => nonce + 1),
      ),
    [promptDraft.storageKey],
  );
  const addToChat = (
    text: string,
    attachments?: readonly PromptDraftAttachment[],
  ) => {
    createCoreComposerActions({ ...promptDraft, focus: () => {} }).replace(
      (current) =>
        appendQuoteAndAttachmentsToDraft(current, text, attachments ?? []),
    );
    setComposerFocusNonce((nonce) => nonce + 1);
  };

  const canUseGitUi = !executionUnavailable && gitDiffTabStatus === "eligible";
  const canCreateTerminal =
    !executionUnavailable &&
    thread?.environmentId != null &&
    environment?.status === "ready" &&
    environmentHost?.status === "connected";
  const createThreadInEnvironment = useCreateThreadInEnvironment({
    projectId,
    environmentId: thread?.environmentId ?? "",
    sectionId: thread?.sectionId ?? null,
    pinned: thread?.pinnedAt != null,
  });
  const { providers: environmentProviders } = useSystemEnvironmentProviders();
  const gitDiff = useGitDiffPanel({
    activeSecondaryTab: isPanelOpen ? activeTab : null,
    clearActiveFileTabs: fileTabs.clearActiveFileTabs,
    defaultMergeBaseBranch: resolveEnvironmentMergeBaseBranch(environment),
    environmentId: canUseGitUi
      ? (thread?.environmentId ?? undefined)
      : undefined,
    mergeBaseBranchOptionsEnabled: mergeBaseOptionsRequested,
    setThreadSecondaryPanel: setSecondaryPanel,
    threadId,
  });
  const closePanel = gitDiff.closeThreadSecondaryPanel;
  const openDiffFile = (path: string) => {
    if (canUseGitUi && path.length > 0) gitDiff.openDiffFile(path);
  };
  const openPluginPanelFromTimeline: ThreadTimelineOpenPluginPanelHandler = ({
    pluginId,
    actionId,
    title,
    params,
  }) => {
    const action = pluginThreadPanels.find(
      (candidate) =>
        candidate.pluginId === pluginId && candidate.id === actionId,
    );
    if (action === undefined) return false;
    const paramsJson = safeSerializePluginPanelParams(pluginId, params);
    if (paramsJson === undefined) return false;
    openPluginPanel({
      pluginId,
      actionId,
      title: title ?? action.title,
      paramsJson,
    });
    return true;
  };
  const storageBrowserController = useThreadStorageBrowser({
    files: storage.threadStorageFiles?.files,
    onSelectPath: (path) => previewStorageFile(path),
    selectedPath: fileTabs.activeStorageFilePath,
  });
  const [isConversationCollapsed, setConversationCollapsed] = useAtom(
    getThreadConversationCollapsedAtom(threadId),
  );
  useEffect(() => {
    setMergeBaseOptionsRequested(false);
  }, [thread?.environmentId]);
  const requestMergeBaseOptions = (open: boolean) => {
    if (open) setMergeBaseOptionsRequested(true);
  };
  const selectFixedPanel = (panel: ThreadSecondaryPanelTab) => {
    fileTabs.clearActiveFileTabs();
    if (panel === "thread-info") setSecondaryPanel("thread-info");
    else if (canUseGitUi) gitDiff.openThreadDiffPanel();
  };
  const fixedTabs: readonly SecondaryPanelFixedTab[] = fixedViewTabs.map(
    (tab) => {
      const isInfo = tab.kind === "thread-info";
      return {
        ariaLabel: isInfo ? "Show thread info panel" : "Show diff panel",
        label: isInfo ? "Info" : "Diff",
        leadingVisual: <Icon name={isInfo ? "Info" : "FileDiff"} />,
        onSelect: () => selectFixedPanel(isInfo ? "thread-info" : "git-diff"),
        tab,
        title: isInfo ? "Thread info" : "Diff",
      };
    },
  );
  const resolveMentionLink: PromptMentionLinkResolver = (resource) => {
    if (resource.kind === "thread") {
      const targetProjectId = resource.projectId ?? projectId;
      return targetProjectId
        ? () =>
            navigateInPane({
              projectId: targetProjectId,
              threadId: resource.threadId,
            })
        : null;
    }
    if (resource.kind === "project") {
      return () => navigate(getProjectComposeRoutePath(resource.projectId));
    }
    if (resource.kind !== "path" || resource.entryKind !== "file") return null;
    if (resource.source === "thread-storage") {
      return () => previewStorageFile(resource.path);
    }
    return thread?.environmentId
      ? () => previewWorkspaceFile(resource.path)
      : null;
  };
  const openNewTab = () => {
    openTab({ kind: "new-tab" });
    setAutoFocusNewTab(true);
  };
  const whenFocused = (run: () => boolean | void) => () =>
    isFocused && run() !== false;
  useAppCommandHandler("panel.newTab", whenFocused(openNewTab));
  useAppCommandHandler(
    "panel.reopenClosedTab",
    whenFocused(fileTabs.reopenClosedTab),
  );
  useAppCommandHandler("file.quickOpen", whenFocused(openNewTab));
  const startTerminal = () => {
    if (!canCreateTerminal || createTerminal.isPending) return false;
    const newTab = createNewTabFixedPanelTab();
    void createTerminal
      .mutateAsync({
        threadId,
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
      })
      .then((session) => {
        closeTab(newTab.id);
        setAutoFocusTerminal(true);
        setActiveTerminal(session.id);
      })
      .catch(() => undefined);
  };
  useAppCommandHandler("terminal.open", whenFocused(startTerminal));
  const closeTerminalTab = (terminalId: string) =>
    closeTerminal.mutate(
      { mode: "force", threadId, terminalId },
      { onSuccess: () => removeTerminalTab(terminalId) },
    );
  useAppCommandHandler("panel.toggle", whenFocused(togglePanel));
  useAppCommandHandler(
    "panel.close",
    whenFocused(() => {
      if (!isPanelOpen) return false;
      if (activeTab === null || !isSecondaryFileTab(activeTab)) closePanel();
      else if (activeTab.kind === "terminal") {
        closeTerminalTab(activeTab.terminalId);
      } else closeTab(activeTab.id);
    }),
  );
  useAppCommandHandler(
    "diff.toggle",
    whenFocused(() => {
      if (!canUseGitUi) return false;
      if (isPanelOpen && activeTab?.kind === "git-diff") closePanel();
      else gitDiff.openThreadDiffPanel();
    }),
  );
  const openChangedFile = (selection: WorkspaceChangedFileSelection) => {
    const target = resolveWorkspaceChangedFileOpenTarget(selection);
    if (target.kind !== "preview") return openDiffFile(selection.file.path);
    previewWorkspaceFile(
      selection.file.path,
      null,
      target.source,
      target.statusLabel,
    );
  };
  const workStatusQuery = useEnvironmentWorkStatus(
    thread?.environmentId,
    gitDiff.requestedMergeBaseBranch,
    { enabled: canUseGitUi && environment !== undefined },
  );
  const workStatus = workStatusQuery.error ? undefined : workStatusQuery.data;
  const workspaceStatus =
    workStatus?.outcome === "available" ? workStatus.workspace : undefined;
  const workspaceUnavailable =
    workStatus?.outcome === "unavailable" ? workStatus.failure : undefined;
  const changedFilesSection =
    selectWorkspaceChangedFilesSection(workspaceStatus);
  const localHostId = useLocalHostId();
  const removedHostName =
    environment !== undefined && environment.hostLifecycle !== "active"
      ? (bootstrapQuery.data?.environmentHostName ?? null)
      : null;
  const isLocalEnvironment =
    environment !== undefined && environment.hostId === localHostId;
  const environmentDisplayHost = useMemo(
    () => ({
      locality: isLocalEnvironment ? ("local" as const) : ("remote" as const),
      identity: ambiguousHost
        ? {
            name: ambiguousHost.name,
            connected: ambiguousHost.status === "connected",
          }
        : removedHostName
          ? { name: removedHostName, connected: false }
          : null,
    }),
    [ambiguousHost, isLocalEnvironment, removedHostName],
  );
  const workspaceRootPath = environment?.path ?? null;
  const openTargets = useOpenTargets(
    executionUnavailable ? null : (environment?.hostId ?? null),
  );
  const { openPath, openInPreferredFileTarget, preferredDirectoryTarget } =
    openTargets;
  const relatedThreadId =
    originKind !== null ? sourceThreadId : thread?.parentThreadId;
  const relationship: "fork" | "parent" =
    originKind === "fork" ? "fork" : "parent";
  const relatedThread = relationship === "parent" ? parentThread : sourceThread;
  const parentThreadSection =
    !thread ||
    !relatedThreadId ||
    (relatedThread !== undefined &&
      (relatedThread.archivedAt !== null ||
        relatedThread.deletedAt !== null ||
        (relationship !== "parent" &&
          relatedThread.projectId !== thread.projectId)))
      ? null
      : {
          parentThreadTitle: relatedThread
            ? getThreadDisplayTitle(relatedThread)
            : relatedThreadId.slice(0, 8),
          href: getThreadRoutePath({
            projectId: relatedThread?.projectId ?? thread.projectId,
            threadId: relatedThreadId,
          }),
          relationship,
        };
  const activeChildThreads = useMemo(
    () =>
      (childThreadsQuery.data ?? [])
        .filter(
          (entry) =>
            entry.originKind === null &&
            (isThreadDisplayStatusBannerActive(entry.runtime.displayStatus) ||
              entry.hasPendingInteraction),
        )
        .map((entry) => ({
          id: entry.id,
          title: getThreadDisplayTitle(entry),
          href: getThreadRoutePath({
            projectId: entry.projectId,
            threadId: entry.id,
          }),
          hasPendingInteraction: entry.hasPendingInteraction,
        }))
        .sort(
          (left, right) =>
            Number(right.hasPendingInteraction) -
            Number(left.hasPendingInteraction),
        ),
    [childThreadsQuery.data],
  );
  const childPendingInteractions =
    useChildThreadPendingAttention(activeChildThreads);
  useThreadReadTracking({ markThreadRead, thread });
  const mergeBase = useEnvironmentMergeBase({
    environment,
    selectedMergeBaseBranch: gitDiff.selectedMergeBaseBranch,
    setSelectedMergeBaseBranch: gitDiff.setSelectedMergeBaseBranch,
    thread,
    updateEnvironment,
    workspaceStatus,
  });
  const gitActions = useThreadGitActions({
    environment,
    requestEnvironmentAction,
    thread,
    workspaceStatus,
  });
  const openLocalFileLink = (link: ThreadTimelineLocalFileLink) => {
    const resolution = resolveThreadLocalFileLink({
      hostFileLinksAvailable: thread?.environmentId != null,
      link,
      threadStorageRootPath: storageRootPath,
      workspaceRootPath,
    });
    if (resolution.kind === "app-route") return false;
    if (resolution.kind === "error") {
      appToast.error("Failed to open file locally", {
        description: resolution.description,
      });
    } else if (resolution.kind === "open-workspace-path") {
      const { relativePath, lineRange } = resolution.request;
      previewWorkspaceFile(relativePath, lineRange);
    } else if (resolution.kind === "open-thread-storage-path") {
      const { relativePath, lineRange } = resolution.request;
      previewStorageFile(relativePath, lineRange);
    } else {
      openTab({
        kind: "host-file-preview",
        tab: {
          lineRange: resolution.request.lineRange,
          path: resolution.request.path,
        },
      });
    }
    return true;
  };
  const openLink = ({ href }: { href: string }) =>
    openHttpUrlInExternalBrowser(href);
  const openWorkspaceFileInEditor = buildOpenInEditorHandler({
    rootPath: workspaceRootPath,
    openInPreferredTarget: openInPreferredFileTarget,
  });
  const openStorageFileInEditor = buildOpenInEditorHandler({
    rootPath: storageRootPath,
    openInPreferredTarget: openInPreferredFileTarget,
  });
  const openHostFileInEditor =
    openInPreferredFileTarget &&
    ((path: string) =>
      openInPreferredFileTarget({
        lineNumber: getFilePreviewLineRangeStart({
          lineRange: fileTabs.activeHostFileLineRange,
        }),
        path,
      }));
  const workspaceOpenPath = preferredDirectoryTarget ? workspaceRootPath : null;
  usePublishThreadPanelOpener(openPluginPanelFromTimeline, isFocused);
  useAppCommandHandler(
    "workspace.openPreferred",
    whenFocused(() => {
      if (fileTabs.activeWorkspaceFilePath && openWorkspaceFileInEditor) {
        openWorkspaceFileInEditor(fileTabs.activeWorkspaceFilePath);
      } else if (fileTabs.activeHostFilePath && openHostFileInEditor) {
        openHostFileInEditor(fileTabs.activeHostFilePath);
      } else if (fileTabs.activeStorageFilePath && openStorageFileInEditor) {
        openStorageFileInEditor(fileTabs.activeStorageFilePath);
      } else if (workspaceOpenPath && preferredDirectoryTarget) {
        void openPath(preferredDirectoryTarget, {
          lineNumber: null,
          path: workspaceOpenPath,
        });
      } else return false;
    }),
  );
  const visibleThread =
    thread && thread.projectId === projectId ? thread : undefined;
  useAppCommandHandler(
    "thread.archive",
    whenFocused(() => {
      if (!visibleThread || visibleThread.archivedAt !== null) return false;
      threadActions.requestArchive(visibleThread);
    }),
  );
  useAppCommandHandler(
    "thread.rename",
    whenFocused(() => {
      if (!visibleThread) return false;
      threadActions.requestRename(visibleThread);
    }),
  );
  const localFileContextMenuItems = (link: ThreadTimelineLocalFileLink) => {
    const lineNumber = getFilePreviewLineRangeStart({
      lineRange: link.lineRange,
    });
    const items: MarkdownLocalFileContextMenuItem[] = [
      {
        id: "copy-path",
        label: "Copy file path",
        onSelect: () => copyFileText(link.path, "path"),
      },
      {
        id: "copy-name",
        label: "Copy file name",
        onSelect: () => copyFileText(getFileBasename(link.path), "name"),
      },
    ];
    if (openTargets.fileTargets.length > 0) {
      items.unshift(
        {
          id: "open-in",
          items: openTargets.fileTargets.map((target) => ({
            id: `open-target:${target.id}`,
            label: `Open in ${target.label}`,
            onSelect: () => {
              void openPath(target, { lineNumber, path: link.path });
            },
          })),
          label: "Open in",
          type: "submenu",
        },
        { id: "copy-separator", type: "separator" },
      );
    }
    return items;
  };

  if (threadQueryState.status === "loading") {
    return <RouteLoadingSkeleton isBoundedPane={isBoundedPane} />;
  }
  if (!thread || thread.projectId !== projectId) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-destructive">
          {threadQuery.error ? "Failed to load thread." : "Not found"}
        </p>
      </PageShell>
    );
  }
  const providerLookup = findEnvironmentDisplayProvider(
    environmentProviders,
    environment?.environmentProviderId ?? null,
  );
  const environmentChrome = environment
    ? getEnvironmentSummaryChrome({
        display: formatEnvironmentDisplay({
          environment,
          host: environmentDisplayHost,
          providerLookup,
        }),
        providerLookup,
        hasMultipleMachines,
        host: environmentHost,
      })
    : undefined;
  const isWorkspaceDeleted = environment?.status === "destroyed";
  const headerGitActions = executionUnavailable
    ? []
    : gitActions.threadHeaderGitActions;
  const openGitAction = gitActions.threadGitActionDialog.onOpen;
  const directoryTarget = workspaceRootPath ? preferredDirectoryTarget : null;
  const openWorkspaceIn = (target: NonNullable<typeof directoryTarget>) =>
    openPath(target, { lineNumber: null, path: workspaceRootPath ?? "" });
  const responsiveActions = [
    ...(directoryTarget
      ? [
          directoryTarget,
          ...openTargets.directoryTargets.filter(
            (target) => target.id !== directoryTarget.id,
          ),
        ].map((target) => ({
          icon: "FolderOpen" as const,
          label: `Open workspace in ${target.label}`,
          onSelect: () => openWorkspaceIn(target),
        }))
      : []),
    ...headerGitActions.map((action) => ({
      icon: "GitBranch" as const,
      label: action.label,
      onSelect: () => openGitAction(action.target),
    })),
  ];
  const mergeBaseOptions = {
    branchRef: gitDiff.selectedMergeBaseBranchRef,
    options: gitDiff.mergeBaseBranchOptions,
    remoteOptions: gitDiff.mergeBaseRemoteBranchOptions,
    optionsLoading: gitDiff.isLoadingMergeBaseBranchOptions,
  };
  const linkRouting = (
    copyPath: string | null | undefined,
    rootPath: string | null,
  ): MarkdownLinkRouting => {
    const baseDir = copyPath
      ? getAbsoluteDirname({ path: copyPath })
      : undefined;
    if (rootPath === null) return { onOpenLink: openLink };
    return {
      onOpenLink: openLink,
      localFile: {
        absoluteLinks: { kind: "contained", rootPath },
        onOpenLink: openLocalFileLink,
        ...(baseDir === undefined
          ? {}
          : { relativeLinks: { baseDir, rootPath } }),
      },
    };
  };
  const renderTabContent = (tab: SecondaryFileFixedPanelTab): ReactNode => {
    const isActive = tab.id === activeTab?.id;
    const preview = {
      activePath: "path" in tab ? tab.path : "",
      isPanelOpen,
      lineRange: "lineRange" in tab ? tab.lineRange : null,
      onSelectionAddToChat: addToChat,
      threadId: thread.id,
    };
    if (tab.kind === "terminal") {
      return (
        <LazyThreadTerminalPanel
          autoFocus={isActive && autoFocusTerminal}
          canCreateTerminal={canCreateTerminal}
          isPanelOpen={isPanelOpen}
          onAutoFocusHandled={() => setAutoFocusTerminal(false)}
          onOpenLink={openLink}
          onSelectionAddToChat={addToChat}
          syncThreadId={thread.id}
          target={{ kind: "thread", threadId: thread.id }}
          terminalId={tab.terminalId}
        />
      );
    }
    if (tab.kind === "new-tab") {
      return (
        <NewTabPage
          autoFocus={isActive && autoFocusNewTab}
          projectId={projectId ?? undefined}
          environmentId={thread.environmentId ?? null}
          currentThreadId={thread.id}
          onAutoFocusHandled={() => setAutoFocusNewTab(false)}
          onSelect={fileTabs.selectFileSearchResult}
          onStartTerminal={
            canCreateTerminal
              ? () => {
                  fileTabs.activateTab(tab.id);
                  startTerminal();
                }
              : undefined
          }
          pluginActions={pluginPanelActions}
        />
      );
    }
    if (tab.kind === "workspace-file-preview") {
      const copyPath = resolveAbsoluteFilePath({
        path: tab.path,
        rootPath: workspaceRootPath,
      });
      return (
        <WorkspaceFilePreviewTabContent
          {...preview}
          copyPath={copyPath}
          environmentId={tab.environmentId}
          markdownLinkRouting={linkRouting(copyPath, workspaceRootPath)}
          onOpenInEditor={openWorkspaceFileInEditor}
          source={tab.source}
          statusLabel={tab.statusLabel}
        />
      );
    }
    if (tab.kind === "host-file-preview") {
      const baseDir = getAbsoluteDirname({ path: tab.path });
      const linkRoot = [workspaceRootPath, storageRootPath].find(
        (rootPath) =>
          rootPath !== null &&
          baseDir !== undefined &&
          isAbsoluteFilePathWithinRoot({ candidatePath: baseDir, rootPath }),
      );
      return (
        <HostFilePreviewTabContent
          {...preview}
          copyPath={tab.path}
          environmentId={tab.environmentId}
          markdownLinkRouting={linkRouting(tab.path, linkRoot ?? null)}
          onOpenInEditor={openHostFileInEditor}
        />
      );
    }
    if (tab.kind === "thread-storage-file-preview") {
      const copyPath = resolveAbsoluteFilePath({
        path: tab.path,
        rootPath: storageRootPath,
      });
      return (
        <ThreadStorageFilePreviewTabContent
          {...preview}
          copyPath={copyPath}
          markdownLinkRouting={linkRouting(copyPath, storageRootPath)}
          onOpenInEditor={openStorageFileInEditor}
        />
      );
    }
    return (
      <ThreadTimelineNavigationProvider
        environmentId={thread.environmentId}
        onOpenLink={openLink}
        onOpenLocalFileLink={openLocalFileLink}
        resolveMentionLink={resolveMentionLink}
        threadId={thread.id}
        workspaceRootPath={environment?.path ?? undefined}
      >
        <PluginPanelTabContent
          tab={tab}
          context={{ kind: "thread", threadId: thread.id }}
        />
      </ThreadTimelineNavigationProvider>
    );
  };
  const tabIcon = (name: "Terminal" | "NewTab") => (
    <Icon
      name={name}
      className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
      aria-hidden
    />
  );
  const panelTabs = (
    terminalSessions === undefined
      ? fileTabs.orderedSecondaryFileTabs
      : buildTerminalSyncedSecondaryFileTabs({
          orderedTabs: fileTabs.orderedSecondaryFileTabs,
          terminalSessions,
        })
  ).map((tab): SecondaryPanelRenderableTab => {
    const shared = {
      contentFillsRegion: false,
      onClose: () => closeTab(tab.id),
      onSelect: () => fileTabs.activateTab(tab.id),
      renderContent: () => renderTabContent(tab),
      statusLabel: null,
      tab,
    };
    if (tab.kind === "terminal") {
      const session = terminalSessions?.find(
        (candidate) => candidate.id === tab.terminalId,
      );
      return {
        ...shared,
        label: session?.title ?? "Terminal",
        leadingVisual: tabIcon("Terminal"),
        statusLabel:
          session === undefined || session.status === "running"
            ? null
            : session.status,
        onSelect: () => {
          setAutoFocusTerminal(true);
          setActiveTerminal(tab.terminalId);
        },
        onClose: () => closeTerminalTab(tab.terminalId),
      };
    }
    if (tab.kind === "new-tab") {
      return { ...shared, label: "New tab", leadingVisual: tabIcon("NewTab") };
    }
    if (tab.kind === "plugin-panel") {
      const action = pluginThreadPanels.find(
        (candidate) =>
          candidate.pluginId === tab.pluginId && candidate.id === tab.actionId,
      );
      return {
        ...shared,
        contentFillsRegion: action?.layout === "flush",
        label: tab.title,
        leadingVisual: (
          <PluginItemIcon
            pluginId={tab.pluginId}
            icon={action?.icon ?? null}
            className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
          />
        ),
      };
    }
    return {
      ...shared,
      label: tab.path.split("/").at(-1) ?? tab.path,
      leadingVisual: <RightPanelFileTabIcon path={tab.path} />,
      ...(tab.kind === "workspace-file-preview"
        ? { statusLabel: tab.statusLabel }
        : {}),
      ...(tab.kind === "thread-storage-file-preview"
        ? { isPinned: tab.isPinned }
        : {}),
    };
  });
  const withFileContextMenu = (node: ReactNode) => (
    <MarkdownLocalFileContextMenuContext.Provider
      value={localFileContextMenuItems}
    >
      {node}
    </MarkdownLocalFileContextMenuContext.Provider>
  );
  const header = (
    <ThreadDetailHeader
      actionsMenu={(includeResponsiveActions) => (
        <ThreadActionsMenu
          thread={thread}
          triggerClassName={HEADER_ICON_BUTTON_CLASS}
          responsiveActions={
            includeResponsiveActions ? responsiveActions : undefined
          }
        />
      )}
      showsChildPill={Boolean(thread.parentThreadId)}
      isSecondaryPanelOpen={isPanelOpen}
      onOpenThreadGitAction={openGitAction}
      onToggleSecondaryPanel={togglePanel}
      threadHeaderGitActions={headerGitActions}
      threadId={thread.id}
      threadTitle={getThreadDisplayTitle(thread)}
      workspaceOpenButton={
        directoryTarget ? (
          <ThreadWorkspaceOpenButton
            preferredTarget={directoryTarget}
            targets={openTargets.directoryTargets}
            onOpenTarget={openWorkspaceIn}
          />
        ) : undefined
      }
    />
  );
  const footer = (
    <ThreadDetailPromptArea
      activeBackgroundAgentCount={thread.activeBackgroundAgentCount}
      canUseGitUi={canUseGitUi}
      contextWindowUsage={timeline.contextWindowUsage}
      environmentCheckout={
        workspaceStatus &&
        formatWorkspaceCheckoutDisplay({ checkout: workspaceStatus.checkout })
      }
      environmentCompactLabel={environmentChrome?.environmentCompactLabel}
      environmentHost={environmentChrome?.environmentHost}
      environmentIcon={environmentChrome?.environmentIcon}
      environmentLabel={environmentChrome?.environmentLabel}
      environmentProviderName={environmentChrome?.environmentProviderName}
      canRestoreEnvironment={thread.canRestoreEnvironment}
      environmentGoneStatus={
        hostLifecycle ?? (isWorkspaceDeleted ? "destroyed" : null)
      }
      environmentHostId={environment?.hostId}
      onCreateNewThreadInEnvironment={
        !executionUnavailable &&
        environment?.status === "ready" &&
        environment.path !== null &&
        projectId &&
        thread.environmentId !== null
          ? createThreadInEnvironment
          : undefined
      }
      onChangedFileClick={openChangedFile}
      projectId={projectId}
      resolveMentionLink={resolveMentionLink}
      workspaceChangedFilesSection={canUseGitUi ? changedFilesSection : null}
      workspaceStatusPending={
        canUseGitUi && (environmentQuery.isLoading || workStatusQuery.isLoading)
      }
      contextBannerMergeBase={
        canUseGitUi &&
        mergeBase.showMergeBase &&
        mergeBase.effectiveMergeBaseBranch
          ? {
              ...mergeBaseOptions,
              branch: mergeBase.effectiveMergeBaseBranch,
              onChange: mergeBase.handleMergeBaseBranchChange,
              onPickerOpenChange: requestMergeBaseOptions,
              onSearchQueryChange: gitDiff.setMergeBaseBranchSearchQuery,
            }
          : null
      }
      composerFocusRequestNonce={composerFocusNonce}
      sendMessage={sendMessage}
      steerActiveThreadOnEnter={
        systemConfigQuery.data?.generalSettings.steerActiveThreadOnEnter ??
        defaultAppSettings.steerActiveThreadOnEnter
      }
      pendingInteractions={pendingInteractions}
      pendingInteractionsInitialLoading={isPendingInteractionStateUnknown(
        pendingInteractionsQuery.data,
        pendingInteractionsQuery.isFetching,
      )}
      queuedMessageCount={thread.queuedMessageCount}
      pendingTodos={timeline.pendingTodos}
      activePromptMode={timeline.activePromptMode}
      goal={timeline.goal}
      modelFallback={timeline.modelFallback}
      activeWorkflows={timeline.activeWorkflows}
      activeBackgroundCommands={timeline.activeBackgroundCommands}
      parentThreadSection={parentThreadSection}
      childPendingInteractions={childPendingInteractions}
      childThreadsSection={
        activeChildThreads.length > 0 ? { items: activeChildThreads } : null
      }
      thread={thread}
    />
  );
  const metadata: ContentProps["metadata"] = {
    thread,
    projectId,
    parentThreadProjectId: parentThread?.projectId ?? null,
    parentThreadDisplayName:
      (parentThread?.title?.trim()
        ? parentThread.title
        : thread.parentThreadId) ?? null,
    parentThreads: loadsParentThreads
      ? (parentThreadsQuery.data ?? NO_THREADS)
      : NO_THREADS,
    canAssignToParent: isThreadRoot,
    canTakeOverThread: Boolean(thread.parentThreadId),
    isLoadingParentThreads: parentThreadsQuery.isLoading,
    isParentThreadsError: parentThreadsQuery.isError,
    environment: environment ?? null,
    environmentProvisioningFailure:
      thread.status === "error" &&
      thread.environmentId === null &&
      hasThreadProvisioningFailure(timelineRows),
    environmentDisplayHost,
    workspaceStatus,
    workspaceStatusError: workStatusQuery.error ?? null,
    workspaceUnavailable,
    selectedMergeBaseBranch: gitDiff.selectedMergeBaseBranch,
    mergeBaseBranchRef: mergeBaseOptions.branchRef,
    mergeBaseBranchOptions: mergeBaseOptions.options,
    mergeBaseRemoteBranchOptions: mergeBaseOptions.remoteOptions,
    isLoadingMergeBaseBranchOptions: mergeBaseOptions.optionsLoading,
    updateThreadPending: updateThread.isPending || updateEnvironment.isPending,
    storage:
      environmentHost?.status === "connected"
        ? {
            controller: storageBrowserController,
            filesError: storage.threadStorageFilesError,
            isFilesLoading: storage.isThreadStorageFilesLoading,
          }
        : undefined,
    onAssignParent: (parentThreadId) => {
      if (updateThread.isPending) return;
      updateThread.mutate({ id: thread.id, parentThreadId });
    },
    onParentSelectorOpenChange: (open) => {
      if (open) setParentThreadsRequestedFor(thread.id);
    },
    onRetryParentThreads: parentThreadsQuery.retry,
    onMergeBaseBranchChange: mergeBase.handleMergeBaseBranchChange,
    onMergeBasePickerOpenChange: requestMergeBaseOptions,
    onMergeBaseBranchSearchQueryChange: gitDiff.setMergeBaseBranchSearchQuery,
    onChangedFileClick: canUseGitUi ? openChangedFile : undefined,
    onCommitClick: canUseGitUi
      ? (sha) => {
          if (sha.length > 0) gitDiff.openCommitDiff(sha);
        }
      : undefined,
  };
  const secondaryPanel: ContentProps["secondaryPanel"] = {
    canNavigateTabs: isFocused,
    activeTab,
    canUseGitUi,
    gitDiffTabStatus,
    environmentId: thread.environmentId ?? undefined,
    workspaceRootPath: environment?.path,
    tabs: panelTabs,
    fixedTabs,
    splitPanelStateId: thread.id,
    isOpen: isPanelOpen,
    onClose: closePanel,
    onCollapse: closePanel,
    onClearPendingGitDiffIntent: gitDiff.clearPendingGitDiffIntent,
    onOpenFileInEditor: openWorkspaceFileInEditor,
    onTabReorder: fileTabs.reorderTab,
    onOpenNewTab: openNewTab,
    onRetryGitDiffEligibility: () => {
      void environmentQuery.refetch();
    },
    onOpenFilePreview: (path) => {
      if (thread.environmentId != null) previewWorkspaceFile(path);
    },
    onSelectionAddToChat: addToChat,
    pendingGitDiffCommitSha: gitDiff.pendingGitDiffCommitSha,
    pendingGitDiffScrollPath: gitDiff.pendingGitDiffScrollPath,
    requestedMergeBaseBranch: gitDiff.requestedMergeBaseBranch,
    onPanelFocus: touchFixedPanelTabsState,
  };
  const timelineProps: ContentProps["timeline"] = {
    activeThinking: timeline.activeThinking,
    contextBoundarySeq: timeline.contextBoundarySeq,
    threadOriginKind: originKind,
    hasOlderTimelineRows: timeline.hasOlderTimelineRows,
    hostConnectionNotice:
      thread.runtime.displayStatus === "waiting-for-host"
        ? { label: `${ambiguousHost?.name ?? "Host"} disconnected` }
        : null,
    isLoadingOlderTimelineRows: timeline.isLoadingOlderTimelineRows,
    isThreadTimelinePending: isTimelinePending,
    timelineError: Boolean(timeline.timelineError),
    onMessageAddToChat: addToChat,
    onLoadOlderRows: timeline.loadOlderTimelineRows,
    onOpenLink: openLink,
    onOpenLocalFileLink: openLocalFileLink,
    onOpenPluginPanel: openPluginPanelFromTimeline,
    onTitleAction: (action) => () => openDiffFile(action.path),
    projectId,
    resolveMentionLink,
    showOngoingIndicator:
      thread.status !== "stopping" &&
      !hasPendingInteraction &&
      isRunningThreadRuntimeDisplayStatus(thread.runtime.displayStatus) &&
      !isTimelinePending,
    timelineRows,
    isStopping: thread.status === "stopping",
    stoppingAnchorAt: thread.updatedAt,
    threadId: thread.id,
    threadRuntimeDisplayStatus: thread.runtime.displayStatus,
    unreadDividerAutoScroll: unreadDividerState.autoScroll,
    unreadDividerPlacement: unreadDividerState.placement,
    workspaceRootPath: environment?.path ?? undefined,
  };

  return (
    <PluginThreadPanelNavigationProvider
      openThreadPanel={openPluginPanelFromTimeline}
    >
      {withFileContextMenu(
        <>
          <ThreadDetailSecondaryContent
            header={header}
            footer={footer}
            isMetadataLoading={environmentQuery.isLoading}
            isSecondaryPanelOpen={isPanelOpen}
            isConversationCollapsed={isConversationCollapsed}
            isBoundedPane={isBoundedPane}
            onToggleSecondaryPanel={togglePanel}
            onToggleConversationCollapse={() =>
              setConversationCollapsed((collapsed) => !collapsed)
            }
            renderHostedPanel={withFileContextMenu}
            metadata={metadata}
            secondaryPanel={secondaryPanel}
            timeline={timelineProps}
          />
          {canUseGitUi ? (
            <ThreadGitActionDialog
              target={gitActions.threadGitActionDialog.target}
              branchName={workspaceStatus?.branch?.currentBranch ?? undefined}
              gitStatusDisplay={getGitStatusDisplay(workspaceStatus, {
                mergeBaseBranch: mergeBase.effectiveMergeBaseBranch,
                showBranchComparison: mergeBase.showBranchComparisonUi,
                error: workStatusQuery.error,
                workspaceUnavailable,
                workspaceDeleted: isWorkspaceDeleted,
              })}
              changedFilesSection={
                changedFilesSection?.kind === "committed"
                  ? null
                  : changedFilesSection
              }
              onOpenChange={(open) => {
                if (!open) gitActions.threadGitActionDialog.onClose();
              }}
              onCommit={gitActions.handleCommitThread}
            />
          ) : null}
        </>,
      )}
    </PluginThreadPanelNavigationProvider>
  );
}

function safeSerializePluginPanelParams(
  pluginId: string,
  params: Parameters<typeof serializePluginPanelParams>[0],
): string | null | undefined {
  try {
    return serializePluginPanelParams(params);
  } catch (error) {
    console.warn(
      `[plugin:${pluginId}] messageDirective openThreadPanel params are invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}
