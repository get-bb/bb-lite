import { appendQuoteAndAttachmentsToDraft } from "@bb/client-core";
import { createCoreComposerActions } from "@/lib/plugin-composer-handle";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { useSystemProviderInfo } from "@/hooks/queries/system-queries";
import { useImmediateRouteNavigate } from "@/components/ui/app-route-anchor";
import {
  isRunningThreadRuntimeDisplayStatus,
  type ThreadTimelineEditMessageHandler,
  type ThreadTimelineEditMessageTarget,
  type ThreadTimelineInlineMessageEditor,
  type ThreadTimelineForkMessageHandler,
  type ThreadTimelineLinkHandler,
  type ThreadTimelineLocalFileLink,
  type ThreadTimelineOpenPluginPanelHandler,
  type TimelineTitleActionResolver,
  useThreadTimelineController,
} from "@/components/thread/timeline";
import { serializePluginPanelParams } from "@/lib/plugin-json-value";
import {
  defaultAppSettings,
  type ThreadListEntry,
  type ThreadWithRuntime,
} from "@bb/domain";
import type { TimelineRow } from "@bb/server-contract";
import { appToast } from "@/components/ui/app-toast";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { useForkThreadFromMessage } from "@/hooks/useForkThreadFromMessage";
import { isThreadForkable } from "@bb/client-core";
import { useRequestEnvironmentAction } from "../../hooks/mutations/environment-mutations";
import {
  useMarkThreadRead,
  useUpdateThread,
} from "../../hooks/mutations/thread-state-mutations";
import {
  useCreateThreadQueuedMessage,
  useEditThreadMessage,
  useSendThreadMessage,
} from "../../hooks/mutations/thread-runtime-mutations";
import { useUpdateEnvironment } from "../../hooks/mutations/environment-mutations";
import {
  useEnvironment,
  useEnvironmentWorkStatus,
} from "../../hooks/queries/environment-queries";
import {
  useChildThreadPendingAttention,
  type ChildThreadPendingAttentionSource,
} from "../../hooks/queries/child-thread-pending-interactions";
import {
  didThreadDetailBootstrapRefreshAfterMount,
  getLatestPendingInteraction,
  isPendingInteractionStateUnknown,
  useChildThreads,
  useProjectThreadSubset,
  useThread,
  useThreadDetailBootstrap,
  useThreadPendingInteractions,
  type ProjectThreadSubsetFilters,
} from "../../hooks/queries/thread-queries";
import { isTransientReadError } from "@/hooks/queries/query-helpers";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { subscribeComposerFocusRequests } from "@/lib/composer-focus-requests";
import { ThreadGitActionDialog } from "@/components/dialogs/ThreadGitActionDialog";
import { PageShell } from "@/components/ui/page-shell.js";
import { RouteLoadingSkeleton } from "@/components/ui/route-loading-skeleton";
import { HEADER_ICON_BUTTON_CLASS } from "@/components/layout/AppPageHeader";
import {
  ThreadActionsMenu,
  type ThreadActionsMenuResponsiveAction,
} from "@/components/thread/ThreadActionsMenu";
import { ThreadWorkspaceOpenButton } from "@/components/thread/ThreadWorkspaceOpenButton";
import {
  formatEnvironmentDisplay,
  type EnvironmentDisplayHostContext,
} from "@bb/core-ui";
import { useCreateThreadInEnvironment } from "@/hooks/useCreateThreadInEnvironment";
import { useLocalHostId, useOpenTargets } from "@/hooks/useOpenTargets";
import { selectHosts, useHosts } from "@/hooks/queries/host-queries";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useConnectionAwareQueryState } from "@/hooks/queries/connection-aware-query-state";
import {
  findEnvironmentDisplayProvider,
  getEnvironmentSummaryChrome,
  isHostAmbiguous,
} from "@/lib/environment-workspace-display";
import { useSystemEnvironmentProviders } from "@/hooks/queries/environment-provider-queries";
import { formatWorkspaceCheckoutDisplay } from "@/lib/workspace-checkout-display";
import { getGitStatusDisplay } from "@/components/workspace/workspace-status";
import { selectWorkspaceChangedFilesSection } from "@/components/workspace/workspace-change-summary";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { hasThreadProvisioningFailure } from "@/lib/thread-provisioning-failure";
import { showMutationErrorToast } from "@/lib/mutation-errors";
import {
  promptInputToDraft,
  type PromptDraftAttachment,
  type PromptDraftState,
} from "@bb/client-core";
import {
  getProjectComposeRoutePath,
  getThreadRoutePath,
  type ThreadRoutePathArgs,
} from "@/lib/route-paths";
import { ThreadDetailHeader } from "./ThreadDetailHeader";
import {
  ThreadDetailPromptArea,
  type ThreadDetailSentMessageEdit,
} from "./ThreadDetailPromptArea";
import {
  isThreadDisplayStatusBannerActive,
  type ThreadPromptParentThreadSection,
  type ThreadPromptChildThreadsSection,
} from "@/components/promptbox/banner/ThreadPromptContextBanner";
import { ThreadDetailSecondaryContent } from "./ThreadDetailSecondaryContent";
import type { HostConnectionNotice } from "@/components/thread/timeline/ThreadTimelineSurface";
import {
  PluginThreadPanelNavigationProvider,
  usePublishThreadPanelOpener,
} from "@/components/plugin/plugin-thread-panel-navigation";
import { usePluginSlots } from "@/plugins/registry";
import { openHttpUrlInExternalBrowser } from "@/lib/url-open-routing";
import { getFileBasename } from "@/lib/live-file-navigation";
import { getFilePreviewLineRangeStart } from "@bb/client-core";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import { useEnvironmentMergeBase } from "@/components/secondary-panel/git-diff/useEnvironmentMergeBase";
import { useThreadGitActions } from "./useThreadGitActions";
import { useThreadPanel } from "@/components/secondary-panel/useThreadPanel";
import { useThreadReadTracking } from "@/hooks/useThreadReadTracking";
import { useThreadUnreadDividerState } from "./useThreadUnreadDividerState";
import { buildOpenInEditorHandler } from "./threadWorkspaceOpenPath";
import {
  resolveThreadLocalFileLink,
  type ThreadLocalFileLinkResolution,
} from "@/lib/thread-local-file-links";
import {
  MarkdownLocalFileContextMenuContext,
  type MarkdownLocalFileContextMenuItem,
} from "@/components/ui/markdown-link-routing";
import { resolveGitDiffTabStatus } from "@/components/secondary-panel/gitDiffTabEligibility";
import { isRootThread } from "./threadParentSelectorOptions";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { usePaneContext } from "./PaneContext";
import { ThreadArchiveCommandHandler } from "./ThreadArchiveCommandHandler";
import { ThreadRenameCommandHandler } from "./ThreadRenameCommandHandler";

const EMPTY_PARENT_THREADS: readonly ThreadListEntry[] = [];
const EMPTY_CHILD_THREAD_ITEMS: readonly ChildThreadPendingAttentionSource[] =
  [];
const EMPTY_PROJECT_THREAD_SUBSET_FILTERS =
  {} satisfies ProjectThreadSubsetFilters;

interface SentMessageEditSession {
  draft: PromptDraftState;
  operationId: string;
  target: ThreadTimelineEditMessageTarget;
  threadId: string;
}

function hasTimelineRowId(
  rows: readonly TimelineRow[],
  rowId: string,
): boolean {
  return rows.some(
    (row) =>
      row.id === rowId ||
      (row.kind === "turn" &&
        row.children !== null &&
        hasTimelineRowId(row.children, rowId)),
  );
}

function buildHostConnectionNotice(
  thread: ThreadWithRuntime,
  hostName: string | null,
): HostConnectionNotice | null {
  if (thread.runtime.displayStatus !== "waiting-for-host") {
    return null;
  }
  return { label: `${hostName ?? "Host"} disconnected` };
}

export function ThreadDetailView(
  props: ThreadRoutePathArgs & { timelineEnabled: boolean },
) {
  const { projectId, threadId, timelineEnabled } = props;
  const { isFocused, navigateInPane, onRequestClose, isBoundedPane } =
    usePaneContext();
  const navigate = useImmediateRouteNavigate();
  const systemConfigQuery = useSystemConfig();
  const threadDetailBootstrapQuery = useThreadDetailBootstrap(threadId);
  const hasThreadDetailBootstrapSettled =
    threadDetailBootstrapQuery.isSuccess || threadDetailBootstrapQuery.isError;
  const {
    data: thread,
    isFetching,
    isLoadingError,
    error,
  } = useThread(threadId, {
    enabled: hasThreadDetailBootstrapSettled,
    refetchOnMount: didThreadDetailBootstrapRefreshAfterMount(
      threadDetailBootstrapQuery,
    )
      ? false
      : "always",
  });
  const environmentQuery = useEnvironment(thread?.environmentId, {
    enabled: hasThreadDetailBootstrapSettled,
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
  const threadQueryState = useConnectionAwareQueryState({
    hasResolvedData: thread !== undefined,
    isFetching: threadDetailBootstrapQuery.isFetching || isFetching,
    isLoadingError,
    isRecoverableLoadingError: isTransientReadError(error),
  });
  const threadOriginKind = thread?.originKind ?? null;
  const threadSourceThreadId =
    thread?.sourceThreadId ??
    (thread && threadOriginKind ? thread.parentThreadId : null);
  const { data: parentThread } = useThread(thread?.parentThreadId ?? "");
  const { data: sourceThread } = useThread(threadSourceThreadId ?? "");
  const pendingInteractionsQuery = useThreadPendingInteractions(
    thread?.id ?? "",
    {
      enabled: threadQueryState.status === "ready" && Boolean(thread?.id),
    },
  );
  const pendingInteractions = pendingInteractionsQuery.data ?? [];
  const pendingInteractionsInitialLoading = isPendingInteractionStateUnknown(
    pendingInteractionsQuery.data,
    pendingInteractionsQuery.isFetching,
  );
  const hasPendingInteraction =
    getLatestPendingInteraction(pendingInteractions) !== null;
  const unreadDividerState = useThreadUnreadDividerState({
    routeThreadId: threadId,
    thread,
  });
  const isThreadRoot = isRootThread(thread);
  const [
    parentThreadsRequestedForThreadId,
    setParentThreadsRequestedForThreadId,
  ] = useState<string | null>(null);
  const shouldLoadParentThreads =
    threadQueryState.status === "ready" &&
    isThreadRoot &&
    parentThreadsRequestedForThreadId === thread?.id;
  const parentThreadSubsetQuery = useProjectThreadSubset({
    enabled: shouldLoadParentThreads,
    filters: EMPTY_PROJECT_THREAD_SUBSET_FILTERS,
    projectId,
  });
  const childThreadSubsetQuery = useChildThreads({
    enabled: threadQueryState.status === "ready" && Boolean(thread?.id),
    parentThreadId: thread?.id,
  });
  const parentThreads = useMemo(
    () =>
      shouldLoadParentThreads
        ? (parentThreadSubsetQuery.data ?? EMPTY_PARENT_THREADS)
        : EMPTY_PARENT_THREADS,
    [parentThreadSubsetQuery.data, shouldLoadParentThreads],
  );
  const handleParentSelectorOpenChange = useCallback(
    (open: boolean) => {
      if (open && thread?.id) {
        setParentThreadsRequestedForThreadId(thread.id);
      }
    },
    [thread?.id],
  );
  const handleRetryParentThreads = parentThreadSubsetQuery.retry;
  const {
    activePromptMode,
    activeThinking,
    activeWorkflows,
    activeBackgroundCommands,
    contextBoundarySeq,
    contextWindowUsage,
    goal,
    hasOlderTimelineRows,
    isLoadingOlderTimelineRows,
    loadOlderTimelineRows,
    modelFallback,
    pendingTodos,
    timelineError,
    timelineLoading,
    timelineRows,
  } = useThreadTimelineController({
    threadId,
    enabled: timelineEnabled,
  });
  const sendMessage = useSendThreadMessage();
  const editMessage = useEditThreadMessage();
  const createQueuedMessage = useCreateThreadQueuedMessage();
  const requestEnvironmentAction = useRequestEnvironmentAction();
  const markThreadRead = useMarkThreadRead();
  const updateEnvironment = useUpdateEnvironment();
  const updateThread = useUpdateThread({
    errorMessage: "Failed to assign parent thread.",
  });
  const hostsQuery = useHosts({
    enabled:
      hasThreadDetailBootstrapSettled &&
      thread?.environmentId !== null &&
      thread?.environmentId !== undefined,
  });
  const connectedHostIds = useMemo(
    () =>
      new Set(
        (hostsQuery.data ?? [])
          .filter((host) => host.status === "connected")
          .map((host) => host.id),
      ),
    [hostsQuery.data],
  );
  const resolvedThreadEnvironmentHost = useMemo(() => {
    const hosts = hostsQuery.data ?? [];
    const environmentHostId = environment?.hostId;
    if (!environmentHostId) return null;
    return hosts.find((host) => host.id === environmentHostId) ?? null;
  }, [environment?.hostId, hostsQuery.data]);
  const hasMultipleMachines =
    selectHosts(hostsQuery.data, "persistent").length > 1;
  const threadEnvironmentHost = isHostAmbiguous(
    hasMultipleMachines,
    resolvedThreadEnvironmentHost?.type ?? null,
  )
    ? resolvedThreadEnvironmentHost
    : null;
  const hostConnectionNotice = useMemo(
    () =>
      thread
        ? buildHostConnectionNotice(thread, threadEnvironmentHost?.name ?? null)
        : null,
    [thread, threadEnvironmentHost],
  );
  const forkThreadFromMessage = useForkThreadFromMessage({
    sourceThread: thread ?? null,
  });
  const handleForkMessage = useCallback<ThreadTimelineForkMessageHandler>(
    (target) => {
      void forkThreadFromMessage(target);
    },
    [forkThreadFromMessage],
  );
  const threadProviderInfo = useSystemProviderInfo(
    thread?.environmentId
      ? {
          enabled: true,
          environmentId: thread.environmentId,
          providerId: thread.providerId,
        }
      : {
          enabled: thread !== undefined,
          providerId: thread?.providerId,
        },
  );
  const isForkAvailable = isThreadForkable(
    thread ?? null,
    threadProviderInfo?.capabilities.supportsFork ?? false,
  );
  const selectionPromptDraftProjectId = thread?.projectId ?? projectId;
  const selectionPromptDraftThreadId = thread?.id ?? "";
  const selectionPromptDraft = useMemo(
    () =>
      getPromptDraftAccessor({
        kind: "thread",
        projectId: selectionPromptDraftProjectId,
        threadId: selectionPromptDraftThreadId,
      }),
    [selectionPromptDraftProjectId, selectionPromptDraftThreadId],
  );
  const [composerFocusRequestNonce, setComposerFocusRequestNonce] = useState(0);
  const [sentMessageEditSession, setSentMessageEditSession] =
    useState<SentMessageEditSession | null>(null);
  const [sentMessageEditHostElement, setSentMessageEditHostElement] =
    useState<HTMLDivElement | null>(null);
  const activeSentMessageEditSession =
    sentMessageEditSession?.threadId === thread?.id
      ? sentMessageEditSession
      : null;
  const canEditSentMessages =
    thread !== undefined &&
    (threadProviderInfo?.capabilities.supportsSessionRewind ?? false) &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    !hasPendingInteraction &&
    sentMessageEditSession === null &&
    !sendMessage.isPending &&
    !createQueuedMessage.isPending &&
    !editMessage.isPending &&
    !(timelineLoading && timelineRows.length === 0) &&
    activeWorkflows.length === 0 &&
    thread.activeBackgroundAgentCount === 0 &&
    activeBackgroundCommands.length === 0;
  const sentMessageEditEntryRef = useRef({ canEditSentMessages, thread });
  sentMessageEditEntryRef.current = { canEditSentMessages, thread };
  const handleEditSentMessage = useCallback<ThreadTimelineEditMessageHandler>(
    (target: ThreadTimelineEditMessageTarget) => {
      const current = sentMessageEditEntryRef.current;
      if (!current.thread || !current.canEditSentMessages) {
        return;
      }
      const editDraft = promptInputToDraft(target.input);
      setSentMessageEditHostElement(null);
      setSentMessageEditSession({
        draft: editDraft,
        operationId: nanoid(),
        target,
        threadId: current.thread.id,
      });
    },
    [],
  );
  const sentMessageEditThreadId = sentMessageEditSession?.threadId ?? null;
  const sentMessageEditTargetMessageId =
    sentMessageEditSession?.target.messageId ?? null;
  const currentThreadId = thread?.id ?? null;
  const sentMessageEditTargetStillPresent =
    sentMessageEditThreadId === currentThreadId &&
    sentMessageEditTargetMessageId !== null
      ? hasTimelineRowId(timelineRows, sentMessageEditTargetMessageId)
      : true;
  const shouldDiscardMissingSentMessageEdit =
    sentMessageEditThreadId !== null &&
    sentMessageEditThreadId === currentThreadId &&
    !timelineLoading &&
    !sentMessageEditTargetStillPresent;
  useEffect(() => {
    if (!shouldDiscardMissingSentMessageEdit) {
      return;
    }
    setSentMessageEditHostElement(null);
    setSentMessageEditSession(null);
    appToast.warning("The message being edited is no longer available.");
  }, [shouldDiscardMissingSentMessageEdit]);
  const activeSentMessageEditOperationId =
    activeSentMessageEditSession?.operationId ?? null;
  const updateSentMessageEditDraft = useCallback(
    (update: (current: PromptDraftState) => PromptDraftState) => {
      setSentMessageEditSession((current) =>
        current?.operationId === activeSentMessageEditOperationId
          ? { ...current, draft: update(current.draft) }
          : current,
      );
    },
    [activeSentMessageEditOperationId],
  );
  const closeSentMessageEdit = useCallback((operationId: string) => {
    setSentMessageEditSession((current) =>
      current?.operationId === operationId ? null : current,
    );
  }, []);
  const cancelSentMessageEdit = useCallback(() => {
    if (!activeSentMessageEditSession) {
      return;
    }
    closeSentMessageEdit(activeSentMessageEditSession.operationId);
  }, [activeSentMessageEditSession, closeSentMessageEdit]);
  const submitSentMessageEdit = useCallback<
    ThreadDetailSentMessageEdit["onSubmit"]
  >(
    (target) => {
      if (!activeSentMessageEditSession) {
        return;
      }
      const session = activeSentMessageEditSession;
      const execution = target.execution;
      void editMessage
        .mutateAsync({
          id: session.threadId,
          operationId: session.operationId,
          expectedRequestSequence: session.target.expectedRequestSequence,
          input: target.input,
          ...(execution
            ? {
                model: execution.model,
                permissionMode: execution.permissionMode,
                reasoningLevel: execution.reasoningLevel,
                executionInputSources: execution.executionInputSources,
                ...(execution.supportsServiceTier && execution.serviceTier
                  ? { serviceTier: execution.serviceTier }
                  : {}),
              }
            : {}),
        })
        .then(() => {
          closeSentMessageEdit(session.operationId);
        })
        .catch((error) => {
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to edit the message",
            lifecycleOperation: "edit_message",
          });
        });
    },
    [activeSentMessageEditSession, closeSentMessageEdit, editMessage],
  );
  const activeSentMessageEditTargetMessageId =
    activeSentMessageEditSession?.target.messageId ?? null;
  const inlineMessageEditor = useMemo<
    ThreadTimelineInlineMessageEditor | undefined
  >(
    () =>
      activeSentMessageEditTargetMessageId !== null
        ? {
            messageId: activeSentMessageEditTargetMessageId,
            onHostElementChange: setSentMessageEditHostElement,
          }
        : undefined,
    [activeSentMessageEditTargetMessageId],
  );
  const sentMessageEdit = useMemo<ThreadDetailSentMessageEdit | undefined>(
    () =>
      activeSentMessageEditSession
        ? {
            draft: activeSentMessageEditSession.draft,
            hostElement: sentMessageEditHostElement,
            isSubmitting: editMessage.isPending,
            operationId: activeSentMessageEditSession.operationId,
            onCancel: cancelSentMessageEdit,
            onSubmit: submitSentMessageEdit,
            updateDraft: updateSentMessageEditDraft,
          }
        : undefined,
    [
      activeSentMessageEditSession,
      cancelSentMessageEdit,
      editMessage.isPending,
      sentMessageEditHostElement,
      submitSentMessageEdit,
      updateSentMessageEditDraft,
    ],
  );
  useEffect(
    () =>
      subscribeComposerFocusRequests(selectionPromptDraft.storageKey, () =>
        setComposerFocusRequestNonce((nonce) => nonce + 1),
      ),
    [selectionPromptDraft.storageKey],
  );
  const composerActions = useMemo(
    () =>
      createCoreComposerActions({
        ...selectionPromptDraft,
        focus: () => setComposerFocusRequestNonce((nonce) => nonce + 1),
      }),
    [selectionPromptDraft],
  );
  const handleSelectionAddToChat = useCallback(
    (text: string, attachments?: readonly PromptDraftAttachment[]) => {
      composerActions.replace((current) =>
        appendQuoteAndAttachmentsToDraft(current, text, attachments ?? []),
      );
      composerActions.focus();
    },
    [composerActions],
  );
  const canUseGitUi = !executionUnavailable && gitDiffTabStatus === "eligible";
  const canCreateTerminal =
    !executionUnavailable &&
    thread?.environmentId !== null &&
    thread?.environmentId !== undefined &&
    environment?.status === "ready" &&
    connectedHostIds.has(environment.hostId);
  const createThreadInEnvironment = useCreateThreadInEnvironment({
    projectId,
    environmentId: thread?.environmentId ?? "",
    sectionId: thread?.sectionId ?? null,
    pinned: thread?.pinnedAt != null,
  });
  const { providers: registeredEnvironmentProviders } =
    useSystemEnvironmentProviders();
  const panel = useThreadPanel({
    threadId,
    thread,
    environment,
    isFocused,
    canUseGitUi,
    canCreateTerminal,
    showsGitDiffTab: gitDiffTabStatus !== "ineligible",
  });
  const {
    isLoadingMergeBaseBranchOptions,
    mergeBaseBranchOptions,
    mergeBaseRemoteBranchOptions,
    onMergeBasePickerOpenChange: handleMergeBasePickerOpenChange,
    openChangedFile: handleChangedFileClick,
    openCommitDiff: openSecondaryPanelCommitDiff,
    openDiffFile: openSecondaryPanelDiffFile,
    openHostFile,
    openPluginPanel,
    openWorkspaceFile,
    requestedMergeBaseBranch,
    selectedMergeBaseBranch,
    selectedMergeBaseBranchRef,
    setMergeBaseBranchSearchQuery,
    setSelectedMergeBaseBranch,
  } = panel;
  const { threadPanels: pluginThreadPanelActions } = usePluginSlots();
  const handleOpenTimelinePluginPanel =
    useCallback<ThreadTimelineOpenPluginPanelHandler>(
      ({ pluginId, actionId, title, params }) => {
        const action = pluginThreadPanelActions.find(
          (candidate) =>
            candidate.pluginId === pluginId && candidate.id === actionId,
        );
        if (action === undefined) return false;
        let paramsJson: string | null;
        try {
          paramsJson = serializePluginPanelParams(params);
        } catch (error) {
          console.warn(
            `[plugin:${pluginId}] messageDirective openThreadPanel params are invalid: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return false;
        }
        openPluginPanel({
          pluginId,
          actionId,
          title: title ?? action.title,
          paramsJson,
        });
        return true;
      },
      [openPluginPanel, pluginThreadPanelActions],
    );
  const resolveMentionLink = useCallback<PromptMentionLinkResolver>(
    (resource) => {
      if (resource.kind === "thread") {
        const targetProjectId = resource.projectId ?? projectId;
        if (!targetProjectId) return null;
        return () =>
          navigateInPane({
            projectId: targetProjectId,
            threadId: resource.threadId,
          });
      }
      if (resource.kind === "project") {
        return () => navigate(getProjectComposeRoutePath(resource.projectId));
      }
      if (resource.kind !== "path" || resource.entryKind !== "file") {
        return null;
      }
      if (resource.source === "thread-storage" || !thread?.environmentId) {
        return null;
      }
      return () =>
        openWorkspaceFile({
          lineRange: null,
          path: resource.path,
          source: { kind: "working-tree" },
          statusLabel: null,
        });
    },
    [
      navigate,
      navigateInPane,
      openWorkspaceFile,
      projectId,
      thread?.environmentId,
    ],
  );
  const workStatusQuery = useEnvironmentWorkStatus(
    thread?.environmentId,
    requestedMergeBaseBranch,
    {
      enabled: canUseGitUi && environment !== undefined,
    },
  );
  const workspaceStatusError = workStatusQuery.error;
  const workStatusResponse = workspaceStatusError
    ? undefined
    : workStatusQuery.data;
  const workspaceStatus =
    workStatusResponse?.outcome === "available"
      ? workStatusResponse.workspace
      : undefined;
  const workspaceUnavailable =
    workStatusResponse?.outcome === "unavailable"
      ? workStatusResponse.failure
      : undefined;
  const workspaceBranch = workspaceStatus?.branch;
  const workspaceChangedFilesSection = useMemo(
    () => selectWorkspaceChangedFilesSection(workspaceStatus),
    [workspaceStatus],
  );
  const workingTreeChangedFilesSection = useMemo(() => {
    if (
      workspaceChangedFilesSection === null ||
      workspaceChangedFilesSection.kind === "committed"
    ) {
      return null;
    }
    return workspaceChangedFilesSection;
  }, [workspaceChangedFilesSection]);
  const localHostId = useLocalHostId();
  const threadEnvironmentIsLocal = environment
    ? environment.hostId === localHostId
    : false;
  const removedEnvironmentHostName =
    environment !== undefined && environment.hostLifecycle !== "active"
      ? (threadDetailBootstrapQuery.data?.environmentHostName ?? null)
      : null;
  const environmentDisplayHostContext = useMemo<EnvironmentDisplayHostContext>(
    () => ({
      locality: threadEnvironmentIsLocal ? "local" : "remote",
      identity: threadEnvironmentHost
        ? {
            name: threadEnvironmentHost.name,
            connected: threadEnvironmentHost.status === "connected",
          }
        : removedEnvironmentHostName
          ? {
              name: removedEnvironmentHostName,
              connected: false,
            }
          : null,
    }),
    [
      removedEnvironmentHostName,
      threadEnvironmentIsLocal,
      threadEnvironmentHost,
    ],
  );
  const workspacePreviewRootPath = environment?.path ?? null;
  const {
    directoryTargets,
    fileTargets,
    openInPreferredFileTarget,
    openPath,
    preferredDirectoryTarget,
  } = useOpenTargets(
    executionUnavailable ? null : (environment?.hostId ?? null),
  );
  const parentThreadSection: ThreadPromptParentThreadSection | null =
    useMemo(() => {
      const relatedThreadId =
        threadOriginKind !== null
          ? threadSourceThreadId
          : thread?.parentThreadId;
      if (!thread || !relatedThreadId) return null;
      const relationship = threadOriginKind === "fork" ? "fork" : "parent";
      const relatedThread =
        relationship === "parent" ? parentThread : sourceThread;
      const href = getThreadRoutePath({
        projectId: relatedThread?.projectId ?? thread.projectId,
        threadId: relatedThreadId,
      });
      if (relatedThread === undefined) {
        return {
          parentThreadTitle: relatedThreadId.slice(0, 8),
          href,
          relationship,
        };
      }
      if (
        relatedThread.archivedAt !== null ||
        relatedThread.deletedAt !== null ||
        (relationship !== "parent" &&
          relatedThread.projectId !== thread.projectId)
      ) {
        return null;
      }
      return {
        parentThreadTitle: getThreadDisplayTitle(relatedThread),
        href,
        relationship,
      };
    }, [
      parentThread,
      sourceThread,
      thread,
      threadOriginKind,
      threadSourceThreadId,
    ]);
  const childThreadsSection: ThreadPromptChildThreadsSection | null =
    useMemo(() => {
      const list = childThreadSubsetQuery.data ?? [];
      const activeItems = list
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
        .sort((left, right) =>
          left.hasPendingInteraction === right.hasPendingInteraction
            ? 0
            : left.hasPendingInteraction
              ? -1
              : 1,
        );
      if (activeItems.length === 0) return null;
      return { items: activeItems };
    }, [childThreadSubsetQuery.data]);
  const childPendingInteractions = useChildThreadPendingAttention(
    childThreadsSection?.items ?? EMPTY_CHILD_THREAD_ITEMS,
  );
  const isThreadTimelinePending = timelineLoading && timelineRows.length === 0;
  useThreadReadTracking({
    markThreadRead,
    thread,
  });
  const {
    effectiveMergeBaseBranch,
    handleMergeBaseBranchChange,
    showBranchComparisonUi,
    showMergeBase,
  } = useEnvironmentMergeBase({
    environment,
    selectedMergeBaseBranch,
    setSelectedMergeBaseBranch,
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
  const parentThreadId = thread?.parentThreadId;
  const parentThreadDisplayName =
    parentThread?.title && parentThread.title.trim().length > 0
      ? parentThread.title
      : parentThreadId;
  const handleAssignParent = useCallback(
    (nextParentThreadId: string | null) => {
      if (!thread || updateThread.isPending) {
        return;
      }

      updateThread.mutate({
        id: thread.id,
        parentThreadId: nextParentThreadId,
      });
    },
    [thread, updateThread],
  );
  const handleTimelineLocalFileLinkResolution = useCallback(
    (resolution: ThreadLocalFileLinkResolution) => {
      if (resolution.kind === "app-route") {
        return false;
      }
      if (resolution.kind === "error") {
        appToast.error("Failed to open file locally", {
          description: resolution.description,
        });
        return true;
      }

      if (resolution.kind === "open-workspace-path") {
        openWorkspaceFile({
          lineRange: resolution.request.lineRange,
          path: resolution.request.relativePath,
          source: { kind: "working-tree" },
          statusLabel: null,
        });
        return true;
      }

      if (resolution.kind === "open-thread-storage-path") {
        return false;
      }

      openHostFile({
        lineRange: resolution.request.lineRange,
        path: resolution.request.path,
      });
      return true;
    },
    [openHostFile, openWorkspaceFile],
  );
  const handleOpenTimelineLocalFileLink = useCallback(
    (link: ThreadTimelineLocalFileLink) => {
      return handleTimelineLocalFileLinkResolution(
        resolveThreadLocalFileLink({
          hostFileLinksAvailable:
            thread?.environmentId !== null &&
            thread?.environmentId !== undefined,
          link,
          threadStorageRootPath: null,
          workspaceRootPath: workspacePreviewRootPath,
        }),
      );
    },
    [
      handleTimelineLocalFileLinkResolution,
      thread?.environmentId,
      workspacePreviewRootPath,
    ],
  );
  const handleOpenTimelineLink = useCallback<ThreadTimelineLinkHandler>(
    ({ href }) => openHttpUrlInExternalBrowser(href),
    [],
  );
  const handleTimelineTitleAction = useCallback<TimelineTitleActionResolver>(
    (action) => () => {
      openSecondaryPanelDiffFile(action.path);
    },
    [openSecondaryPanelDiffFile],
  );
  const handleOpenFileInEditor = useMemo(
    () =>
      buildOpenInEditorHandler({
        rootPath: workspacePreviewRootPath,
        openInPreferredTarget: openInPreferredFileTarget,
      }),
    [openInPreferredFileTarget, workspacePreviewRootPath],
  );
  const workspaceOpenPath = preferredDirectoryTarget
    ? (environment?.path ?? null)
    : null;
  usePublishThreadPanelOpener(handleOpenTimelinePluginPanel, isFocused);
  useAppCommandHandler("workspace.openPreferred", () => {
    if (!isFocused) return false;
    if (workspaceOpenPath && preferredDirectoryTarget) {
      void openPath(preferredDirectoryTarget, {
        lineNumber: null,
        path: workspaceOpenPath,
      });
      return true;
    }
    return false;
  });
  const getLocalFileContextMenuItems = useCallback(
    (link: ThreadTimelineLocalFileLink) => {
      const lineNumber = getFilePreviewLineRangeStart({
        lineRange: link.lineRange,
      });
      const openTargetItems = fileTargets.map((target) => ({
        id: `open-target:${target.id}`,
        label: `Open in ${target.label}`,
        onSelect: () => {
          void openPath(target, { lineNumber, path: link.path });
        },
      }));
      const items: MarkdownLocalFileContextMenuItem[] = [];
      if (openTargetItems.length > 0) {
        items.push({
          id: "open-in",
          items: openTargetItems,
          label: "Open in",
          type: "submenu",
        });
      }
      if (items.length > 0) {
        items.push({ id: "copy-separator", type: "separator" });
      }
      items.push(
        {
          id: "copy-path",
          label: "Copy file path",
          onSelect: () => {
            void copyToClipboardWithToast(link.path, {
              successMessage: "File path copied",
              errorMessage: "Failed to copy file path",
            });
          },
        },
        {
          id: "copy-name",
          label: "Copy file name",
          onSelect: () => {
            void copyToClipboardWithToast(getFileBasename(link.path), {
              successMessage: "File name copied",
              errorMessage: "Failed to copy file name",
            });
          },
        },
      );
      return items;
    },
    [fileTargets, openPath],
  );

  if (threadQueryState.status === "loading") {
    return <RouteLoadingSkeleton isBoundedPane={isBoundedPane} />;
  }
  if (!thread || thread.projectId !== projectId) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-destructive">
          {error ? "Failed to load thread." : "Not found"}
        </p>
      </PageShell>
    );
  }
  const canAssignToParent = isThreadRoot;
  const canTakeOverThread = Boolean(thread.parentThreadId);
  const environmentProvisioningFailure =
    thread.status === "error" && thread.environmentId === null
      ? hasThreadProvisioningFailure(timelineRows)
      : false;
  const threadEnvironmentProviderLookup = findEnvironmentDisplayProvider(
    registeredEnvironmentProviders,
    environment?.environmentProviderId ?? null,
  );
  const threadEnvironmentDisplay = environment
    ? formatEnvironmentDisplay({
        environment,
        host: environmentDisplayHostContext,
        providerLookup: threadEnvironmentProviderLookup,
      })
    : undefined;
  const composerEnvironmentChrome = threadEnvironmentDisplay
    ? getEnvironmentSummaryChrome({
        display: threadEnvironmentDisplay,
        providerLookup: threadEnvironmentProviderLookup,
        hasMultipleMachines,
        host: resolvedThreadEnvironmentHost,
      })
    : undefined;
  const isThreadOnReusableEnvironment =
    !executionUnavailable &&
    environment !== undefined &&
    environment.status === "ready" &&
    environment.path !== null;
  const onCreateNewThreadInEnvironment =
    isThreadOnReusableEnvironment && projectId && thread.environmentId !== null
      ? createThreadInEnvironment
      : undefined;
  const promptBannerMergeBaseBranch = effectiveMergeBaseBranch;
  const threadBranchName = workspaceBranch?.currentBranch ?? undefined;
  const threadCheckoutDisplay = workspaceStatus
    ? formatWorkspaceCheckoutDisplay({ checkout: workspaceStatus.checkout })
    : undefined;
  const isWorkspaceDeleted = environment?.status === "destroyed";
  const threadEnvironmentGoneStatus =
    hostLifecycle ??
    (environment?.status === "destroyed" ? environment.status : null);
  const threadGitStatusDisplay = getGitStatusDisplay(workspaceStatus, {
    mergeBaseBranch: effectiveMergeBaseBranch,
    showBranchComparison: showBranchComparisonUi,
    error: workspaceStatusError,
    workspaceUnavailable,
    workspaceDeleted: isWorkspaceDeleted,
  });
  const threadTitle = getThreadDisplayTitle(thread);
  const responsiveWorkspaceActions: ThreadActionsMenuResponsiveAction[] =
    workspaceOpenPath && preferredDirectoryTarget
      ? [
          preferredDirectoryTarget,
          ...directoryTargets.filter(
            (target) => target.id !== preferredDirectoryTarget.id,
          ),
        ].map((target) => ({
          icon: "FolderOpen" as const,
          label: `Open workspace in ${target.label}`,
          onSelect: () =>
            openPath(target, { lineNumber: null, path: workspaceOpenPath }),
        }))
      : [];
  const responsiveGitActions: ThreadActionsMenuResponsiveAction[] = (
    executionUnavailable ? [] : gitActions.threadHeaderGitActions
  ).map((action) => ({
    icon: "GitBranch" as const,
    label: action.label,
    onSelect: () => {
      gitActions.threadGitActionDialog.onOpen(action.target);
    },
  }));
  const responsiveHeaderActions = [
    ...responsiveWorkspaceActions,
    ...responsiveGitActions,
  ];
  const workspaceOpenButton =
    workspaceOpenPath && preferredDirectoryTarget ? (
      <ThreadWorkspaceOpenButton
        preferredTarget={preferredDirectoryTarget}
        targets={directoryTargets}
        onOpenTarget={(target) =>
          openPath(target, { lineNumber: null, path: workspaceOpenPath })
        }
      />
    ) : undefined;
  const timelineHeader = (
    <ThreadDetailHeader
      actionsMenu={(includeResponsiveActions) => (
        <ThreadActionsMenu
          thread={thread}
          triggerClassName={HEADER_ICON_BUTTON_CLASS}
          responsiveActions={
            includeResponsiveActions ? responsiveHeaderActions : undefined
          }
        />
      )}
      childPillLabel={parentThreadId ? "child" : null}
      isSecondaryPanelOpen={panel.isOpen}
      onClosePane={onRequestClose ?? undefined}
      onOpenThreadGitAction={gitActions.threadGitActionDialog.onOpen}
      onToggleSecondaryPanel={panel.toggle}
      threadHeaderGitActions={
        executionUnavailable ? [] : gitActions.threadHeaderGitActions
      }
      threadId={thread.id}
      threadTitle={threadTitle}
      workspaceOpenButton={workspaceOpenButton}
    />
  );
  const composerFooter = (
    <ThreadDetailPromptArea
      activeBackgroundAgentCount={thread.activeBackgroundAgentCount}
      canUseGitUi={canUseGitUi}
      contextWindowUsage={contextWindowUsage}
      environmentCheckout={threadCheckoutDisplay}
      environmentCompactLabel={
        composerEnvironmentChrome?.environmentCompactLabel
      }
      environmentHost={composerEnvironmentChrome?.environmentHost}
      environmentIcon={composerEnvironmentChrome?.environmentIcon}
      environmentLabel={composerEnvironmentChrome?.environmentLabel}
      environmentProviderName={
        composerEnvironmentChrome?.environmentProviderName
      }
      canRestoreEnvironment={thread.canRestoreEnvironment}
      environmentGoneStatus={threadEnvironmentGoneStatus}
      environmentHostId={environment?.hostId}
      onCreateNewThreadInEnvironment={onCreateNewThreadInEnvironment}
      onChangedFileClick={handleChangedFileClick}
      projectId={projectId}
      resolveMentionLink={resolveMentionLink}
      workspaceChangedFilesSection={
        canUseGitUi ? workspaceChangedFilesSection : null
      }
      workspaceStatusPending={
        canUseGitUi && (environmentQuery.isLoading || workStatusQuery.isLoading)
      }
      contextBannerMergeBase={
        canUseGitUi && showMergeBase && promptBannerMergeBaseBranch
          ? {
              branch: promptBannerMergeBaseBranch,
              branchRef: selectedMergeBaseBranchRef,
              options: mergeBaseBranchOptions,
              remoteOptions: mergeBaseRemoteBranchOptions,
              optionsLoading: isLoadingMergeBaseBranchOptions,
              onChange: handleMergeBaseBranchChange,
              onPickerOpenChange: handleMergeBasePickerOpenChange,
              onSearchQueryChange: setMergeBaseBranchSearchQuery,
            }
          : null
      }
      composerFocusRequestNonce={composerFocusRequestNonce}
      sendMessage={sendMessage}
      sentMessageEdit={sentMessageEdit}
      steerActiveThreadOnEnter={
        systemConfigQuery.data?.generalSettings.steerActiveThreadOnEnter ??
        defaultAppSettings.steerActiveThreadOnEnter
      }
      pendingInteractions={pendingInteractions}
      pendingInteractionsInitialLoading={pendingInteractionsInitialLoading}
      queuedMessageCount={thread.queuedMessageCount}
      pendingTodos={pendingTodos}
      activePromptMode={activePromptMode}
      goal={goal}
      modelFallback={modelFallback}
      activeWorkflows={activeWorkflows}
      activeBackgroundCommands={activeBackgroundCommands}
      parentThreadSection={parentThreadSection}
      childPendingInteractions={childPendingInteractions}
      childThreadsSection={childThreadsSection}
      thread={thread}
    />
  );
  const threadDetailContent = (
    <MarkdownLocalFileContextMenuContext.Provider
      value={getLocalFileContextMenuItems}
    >
      <ThreadDetailSecondaryContent
        footer={composerFooter}
        header={timelineHeader}
        isMetadataLoading={environmentQuery.isLoading}
        isBoundedPane={isBoundedPane}
        panel={panel}
        environment={environment}
        isFocused={isFocused}
        canCreateTerminal={canCreateTerminal}
        gitDiffTabStatus={gitDiffTabStatus}
        onRetryGitDiffEligibility={() => void environmentQuery.refetch()}
        onOpenLink={handleOpenTimelineLink}
        onOpenLocalFileLink={handleOpenTimelineLocalFileLink}
        resolveMentionLink={resolveMentionLink}
        onOpenFileInEditor={handleOpenFileInEditor}
        openInPreferredFileTarget={openInPreferredFileTarget}
        renderHostedPanel={(panel) => (
          <MarkdownLocalFileContextMenuContext.Provider
            value={getLocalFileContextMenuItems}
          >
            {panel}
          </MarkdownLocalFileContextMenuContext.Provider>
        )}
        metadata={{
          thread,
          projectId,
          parentThreadProjectId: parentThread?.projectId ?? null,
          parentThreadDisplayName: parentThreadDisplayName ?? null,
          parentThreads,
          canAssignToParent,
          canTakeOverThread,
          isLoadingParentThreads: parentThreadSubsetQuery.isLoading,
          isParentThreadsError: parentThreadSubsetQuery.isError,
          environment: environment ?? null,
          environmentProvisioningFailure,
          environmentDisplayHost: environmentDisplayHostContext,
          workspaceStatus,
          workspaceStatusError: workspaceStatusError ?? null,
          workspaceUnavailable,
          selectedMergeBaseBranch,
          mergeBaseBranchRef: selectedMergeBaseBranchRef,
          mergeBaseBranchOptions,
          mergeBaseRemoteBranchOptions,
          isLoadingMergeBaseBranchOptions,
          updateThreadPending:
            updateThread.isPending || updateEnvironment.isPending,
          onAssignParent: handleAssignParent,
          onParentSelectorOpenChange: handleParentSelectorOpenChange,
          onRetryParentThreads: handleRetryParentThreads,
          onMergeBaseBranchChange: handleMergeBaseBranchChange,
          onMergeBasePickerOpenChange: handleMergeBasePickerOpenChange,
          onMergeBaseBranchSearchQueryChange: setMergeBaseBranchSearchQuery,
          onChangedFileClick: canUseGitUi ? handleChangedFileClick : undefined,
          onCommitClick: canUseGitUi ? openSecondaryPanelCommitDiff : undefined,
        }}
        timeline={{
          activeThinking,
          canSpawnChild: thread.canSpawnChild,
          contextBoundarySeq,
          threadOriginKind,
          hasOlderTimelineRows,
          hostConnectionNotice,
          isLoadingOlderTimelineRows,
          isThreadTimelinePending,
          timelineError: Boolean(timelineError),
          onForkMessage: isForkAvailable ? handleForkMessage : undefined,
          onEditMessage: canEditSentMessages
            ? handleEditSentMessage
            : undefined,
          inlineMessageEditor,
          onMessageAddToChat: handleSelectionAddToChat,
          onSelectionAddToChat: handleSelectionAddToChat,
          onLoadOlderRows: loadOlderTimelineRows,
          onOpenLink: handleOpenTimelineLink,
          onOpenLocalFileLink: handleOpenTimelineLocalFileLink,
          onOpenPluginPanel: handleOpenTimelinePluginPanel,
          onTitleAction: handleTimelineTitleAction,
          projectId,
          resolveMentionLink,
          showOngoingIndicator:
            thread.status !== "stopping" &&
            !hasPendingInteraction &&
            isRunningThreadRuntimeDisplayStatus(thread.runtime.displayStatus) &&
            !isThreadTimelinePending,
          timelineRows,
          isStopping: thread.status === "stopping",
          stoppingAnchorAt: thread.updatedAt,
          threadId: thread.id,
          threadRuntimeDisplayStatus: thread.runtime.displayStatus,
          unreadDividerAutoScroll: unreadDividerState.autoScroll,
          unreadDividerPlacement: unreadDividerState.placement,
          workspaceRootPath: environment?.path ?? undefined,
        }}
      />
      {canUseGitUi ? (
        <ThreadGitActionDialog
          target={gitActions.threadGitActionDialog.target}
          branchName={threadBranchName}
          gitStatusDisplay={threadGitStatusDisplay}
          changedFilesSection={workingTreeChangedFilesSection}
          onOpenChange={(open) => {
            if (!open) {
              gitActions.threadGitActionDialog.onClose();
            }
          }}
          onCommit={gitActions.handleCommitThread}
        />
      ) : null}
    </MarkdownLocalFileContextMenuContext.Provider>
  );
  return (
    <>
      <ThreadArchiveCommandHandler thread={thread} />
      <ThreadRenameCommandHandler thread={thread} />
      <PluginThreadPanelNavigationProvider
        openThreadPanel={handleOpenTimelinePluginPanel}
      >
        {threadDetailContent}
      </PluginThreadPanelNavigationProvider>
    </>
  );
}
