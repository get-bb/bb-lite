import {
  appendQuoteAndAttachmentsToDraft,
  type PromptDraftAttachment,
} from "@bb/client-core";
import { useMemo, useState, type ComponentProps } from "react";
import { useSystemConfig } from "@bb/app-kit/hooks/queries/system-queries";
import { useImmediateRouteNavigate } from "@bb/app-kit/components/ui/app-route-anchor";
import {
  isRunningThreadRuntimeDisplayStatus,
  useThreadTimelineController,
} from "../../components/thread/timeline";
import { defaultAppSettings, type ThreadListEntry } from "@bb/domain";
import {
  useRequestEnvironmentAction,
  useUpdateEnvironment,
} from "@bb/app-kit/hooks/mutations/environment-mutations";
import {
  useMarkThreadRead,
  useUpdateThread,
} from "@bb/app-kit/hooks/mutations/thread-state-mutations";
import { useSendThreadMessage } from "@bb/app-kit/hooks/mutations/thread-runtime-mutations";
import {
  useEnvironment,
  useEnvironmentWorkStatus,
} from "@bb/app-kit/hooks/queries/environment-queries";
import { useChildThreadPendingAttention } from "@bb/app-kit/hooks/queries/child-thread-pending-interactions";
import {
  didThreadDetailBootstrapRefreshAfterMount,
  getLatestPendingInteraction,
  isPendingInteractionStateUnknown,
  useChildThreads,
  useProjectThreadSubset,
  useThread,
  useThreadDetailBootstrap,
  useThreadPendingInteractions,
} from "@bb/app-kit/hooks/queries/thread-queries";
import { getPromptDraftAccessor } from "@bb/app-kit/hooks/usePromptDraftStorage";
import { ThreadGitActionDialog } from "@bb/app-kit/components/dialogs/ThreadGitActionDialog";
import { PageShell } from "@bb/app-kit/components/ui/page-shell";
import { RouteLoadingSkeleton } from "@bb/app-kit/components/ui/route-loading-skeleton";
import { HEADER_ICON_BUTTON_CLASS } from "@bb/app-kit/components/layout/AppPageHeader";
import { ThreadActionsMenu } from "../../components/thread/ThreadActionsMenu";
import { useThreadActions } from "@bb/app-kit/components/thread/ThreadActionsProvider";
import { ThreadWorkspaceOpenButton } from "../../components/thread/ThreadWorkspaceOpenButton";
import { formatEnvironmentDisplay } from "@bb/core-ui";
import { useCreateThreadInEnvironment } from "@bb/app-kit/hooks/useCreateThreadInEnvironment";
import {
  useLocalHostId,
  useOpenTargets,
} from "@bb/app-kit/hooks/useOpenTargets";
import { selectHosts, useHosts } from "@bb/app-kit/hooks/queries/host-queries";
import {
  findEnvironmentDisplayProvider,
  getEnvironmentSummaryChrome,
  isHostAmbiguous,
} from "@bb/app-kit/lib/environment-workspace-display";
import { useSystemEnvironmentProviders } from "@bb/app-kit/hooks/queries/environment-provider-queries";
import { formatWorkspaceCheckoutDisplay } from "@bb/app-kit/lib/workspace-checkout-display";
import { getGitStatusDisplay } from "@bb/app-kit/components/workspace/workspace-status";
import { selectWorkspaceChangedFilesSection } from "@bb/app-kit/components/workspace/workspace-change-summary";
import { getThreadDisplayTitle } from "@bb/app-kit/lib/thread-title";
import { hasThreadProvisioningFailure } from "@bb/app-kit/lib/thread-provisioning-failure";
import {
  getProjectComposeRoutePath,
  getThreadRoutePath,
  type ThreadRoutePathArgs,
} from "@bb/app-kit/lib/route-paths";
import { ThreadDetailHeader } from "./ThreadDetailHeader";
import { ThreadDetailPromptArea } from "./ThreadDetailPromptArea";
import { isThreadDisplayStatusBannerActive } from "bb-plugin-composer/contract";
import { ThreadDetailSecondaryContent } from "bb-plugin-side-panel/contract";
import { PluginThreadPanelNavigationProvider } from "@bb/app-kit/components/plugin/plugin-thread-panel-navigation";
import type { PromptMentionLinkResolver } from "@bb/app-kit/components/promptbox/editor/prompt-mention-link";
import { useEnvironmentMergeBase } from "bb-plugin-side-panel/contract";
import { openThreadLink, useThreadPanel } from "bb-plugin-side-panel/contract";
import { useThreadGitActions } from "./useThreadGitActions";
import { useThreadReadTracking } from "@bb/app-kit/hooks/useThreadReadTracking";
import { useThreadUnreadDividerState } from "./useThreadUnreadDividerState";
import { isRootThread } from "@bb/app-kit/views/thread-detail/threadParentSelectorOptions";
import { useAppCommandHandler } from "@bb/app-kit/components/commands/AppCommandProvider";
import { useReportViewedThread } from "@bb/app-kit/lib/presence";
import { usePaneContext } from "@bb/app-kit/views/thread-detail/PaneContext";

type ContentProps = ComponentProps<typeof ThreadDetailSecondaryContent>;
const NO_THREADS: readonly ThreadListEntry[] = [];
const NO_FILTERS = {};

export function ThreadDetailView({
  projectId,
  threadId,
  timelineEnabled,
}: ThreadRoutePathArgs & { timelineEnabled: boolean }) {
  const { isFocused, navigateInPane, isBoundedPane } = usePaneContext();
  useReportViewedThread(timelineEnabled ? threadId : null);
  const navigate = useImmediateRouteNavigate();
  const threadActions = useThreadActions();
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
  const isThreadLoading =
    thread === undefined &&
    (bootstrapQuery.isFetching || threadQuery.isFetching);
  const isReady = thread !== undefined;
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
  const addToChat = (
    text: string,
    attachments?: readonly PromptDraftAttachment[],
  ) => {
    promptDraft.setDraft(
      appendQuoteAndAttachmentsToDraft(
        promptDraft.getCurrent(),
        text,
        attachments ?? [],
      ),
    );
    setComposerFocusNonce((nonce) => nonce + 1);
  };

  const workspaceRootPath = environment?.path ?? null;
  const openTargets = useOpenTargets(
    executionUnavailable ? null : (environment?.hostId ?? null),
  );
  const { openPath, preferredDirectoryTarget } = openTargets;
  const panel = useThreadPanel({
    threadId,
    thread,
    environment,
    environmentLoadFailed: environmentQuery.isError,
    executionUnavailable,
    hostConnected: environmentHost?.status === "connected",
    isFocused,
    openTargets,
  });
  const { canUseGitUi } = panel;
  const createThreadInEnvironment = useCreateThreadInEnvironment({
    projectId,
    environmentId: thread?.environmentId ?? "",
    sectionId: thread?.sectionId ?? null,
    pinned: thread?.pinnedAt != null,
  });
  const { providers: environmentProviders } = useSystemEnvironmentProviders();
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
    return resource.source !== "thread-storage" && thread?.environmentId
      ? () => panel.previewWorkspaceFile(resource.path)
      : null;
  };
  const whenFocused = (run: () => boolean | void) => () =>
    isFocused && run() !== false;
  const workStatusQuery = useEnvironmentWorkStatus(
    thread?.environmentId,
    panel.requestedMergeBaseBranch,
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
    selectedMergeBaseBranch: panel.selectedMergeBaseBranch,
    setSelectedMergeBaseBranch: panel.setSelectedMergeBaseBranch,
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
  const workspaceOpenPath = preferredDirectoryTarget ? workspaceRootPath : null;
  useAppCommandHandler(
    "workspace.openPreferred",
    whenFocused(() => {
      if (!workspaceOpenPath || !preferredDirectoryTarget) return false;
      void openPath(preferredDirectoryTarget, {
        lineNumber: null,
        path: workspaceOpenPath,
      });
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

  if (isThreadLoading) {
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
    branchRef: panel.selectedMergeBaseBranchRef,
    options: panel.mergeBaseBranchOptions,
    remoteOptions: panel.mergeBaseRemoteBranchOptions,
    optionsLoading: panel.isLoadingMergeBaseBranchOptions,
  };
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
      isSecondaryPanelOpen={panel.isOpen}
      onOpenThreadGitAction={openGitAction}
      onToggleSecondaryPanel={panel.toggle}
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
      onChangedFileClick={panel.openChangedFile}
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
              onPickerOpenChange: panel.onMergeBasePickerOpenChange,
              onSearchQueryChange: panel.setMergeBaseBranchSearchQuery,
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
      pendingTodos={timeline.pendingTodos}
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
    selectedMergeBaseBranch: panel.selectedMergeBaseBranch,
    mergeBaseBranchRef: mergeBaseOptions.branchRef,
    mergeBaseBranchOptions: mergeBaseOptions.options,
    mergeBaseRemoteBranchOptions: mergeBaseOptions.remoteOptions,
    isLoadingMergeBaseBranchOptions: mergeBaseOptions.optionsLoading,
    updateThreadPending: updateThread.isPending || updateEnvironment.isPending,
    onAssignParent: (parentThreadId) => {
      if (updateThread.isPending) return;
      updateThread.mutate({ id: thread.id, parentThreadId });
    },
    onParentSelectorOpenChange: (open) => {
      if (open) setParentThreadsRequestedFor(thread.id);
    },
    onRetryParentThreads: parentThreadsQuery.retry,
    onMergeBaseBranchChange: mergeBase.handleMergeBaseBranchChange,
    onMergeBasePickerOpenChange: panel.onMergeBasePickerOpenChange,
    onMergeBaseBranchSearchQueryChange: panel.setMergeBaseBranchSearchQuery,
    onChangedFileClick: canUseGitUi ? panel.openChangedFile : undefined,
    onCommitClick: canUseGitUi ? panel.openCommitDiff : undefined,
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
    onOpenLink: openThreadLink,
    onOpenLocalFileLink: panel.openLocalFileLink,
    onOpenPluginPanel: panel.openPluginPanelFromTimeline,
    onTitleAction: (action) => () => panel.openDiffFile(action.path),
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
      openThreadPanel={panel.openPluginPanelFromTimeline}
    >
      <ThreadDetailSecondaryContent
        header={header}
        footer={footer}
        isMetadataLoading={environmentQuery.isLoading}
        isBoundedPane={isBoundedPane}
        metadata={metadata}
        onRetryGitDiffEligibility={() => {
          void environmentQuery.refetch();
        }}
        panel={panel}
        resolveMentionLink={resolveMentionLink}
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
    </PluginThreadPanelNavigationProvider>
  );
}
