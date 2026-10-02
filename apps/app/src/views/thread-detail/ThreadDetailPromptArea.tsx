import type { MachineRemovalStatus } from "@/lib/machine-removal-display";
import { useState } from "react";
import type { IconName } from "@bb/shared-ui/icon";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import {
  getFollowUpPromptPlaceholder,
  getCompactFollowUpPromptPlaceholder,
} from "@/components/promptbox/follow-up-placeholder";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import type {
  PendingInteraction,
  ThreadQueuedMessage,
  ThreadTimelineActivePromptMode,
  ThreadTimelineModelFallback,
  ThreadTimelinePendingTodos,
  ThreadWithRuntime,
} from "@bb/domain";
import type { ThreadTimelineResponse } from "@bb/server-contract";
import type { ChildThreadPendingAttention } from "@/hooks/queries/child-thread-pending-interactions";
import { ThreadPendingInteractionBanner } from "@/components/thread/pending-interactions/ThreadPendingInteractionBanner";
import {
  ThreadPromptContextBanner,
  type ContextBannerMergeBaseConfig,
  type ThreadPromptContextBannerExpandedSection,
  type ThreadPromptParentThreadSection,
  type ThreadPromptChildThreadsSection,
} from "@/components/promptbox/banner/ThreadPromptContextBanner";
import { ThreadTodoCard } from "@/components/promptbox/banner/ThreadTodoCard";
import { ThreadPromptModeCard } from "@/components/promptbox/banner/ThreadPromptModeCard";
import type {
  WorkspaceChangedFileSelection,
  WorkspaceChangedFilesSection,
} from "@/components/workspace/workspace-change-summary";
import {
  QueuedMessagesList,
  type QueuedMessageInlineEditor,
} from "@/components/promptbox/banner/QueuedMessagesList";
import { ThreadEnvironmentSummary } from "@/components/promptbox/ThreadEnvironmentSummary";
import type { MachineLabelHost } from "@/components/machines/MachineLabel";
import type { WorkspaceCheckoutDisplay } from "@/lib/workspace-checkout-display";
import { useLatestRef } from "@/hooks/useLatestRef";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import { useProjectDisplayName } from "@/hooks/queries/sidebar-navigation-query";
import {
  useActiveComposerDraft,
  useComposerAttachmentUploads,
  useComposerTypeahead,
  useInlineQueuedMessageEditing,
  useQueuedMessageActions,
} from "@/components/thread/embedded-chat";
import {
  useCreateThreadQueuedMessage,
  useCancelThreadPlan,
  useStopThread,
} from "@/hooks/mutations/thread-runtime-mutations";
import {
  useRestoreThreadEnvironment,
  useUnarchiveThread,
} from "@/hooks/mutations/thread-state-mutations";
import {
  getLatestPendingInteraction,
  useThreadQueuedMessages,
  useThreadPromptHistory,
} from "@/hooks/queries/thread-queries";
import { useThreadDefaultExecutionOptions } from "@/hooks/queries/thread-default-execution-options-query";
import { showMutationErrorToast } from "@/lib/mutation-errors";
import { promptHistoryEntriesToDrafts } from "@/lib/prompt-history";
import {
  FollowUpPromptBox,
  type FollowUpPromptBoxProps,
} from "@/components/promptbox/FollowUpPromptBox";
import type { SendMessageMutationLike } from "./threadDetailMutationTypes";
import {
  buildAutoFollowUpRequest,
  buildCreateQueuedFollowUpRequest,
  buildFollowUpSubmitMode,
  buildFollowUpShortcutRequest,
  canSubmitFollowUpShortcut,
  resolveDefaultExecutionOptionsState,
  shouldQueueFollowUpMessage,
  type FollowUpExecutionSelection,
} from "@bb/client-core";

const ignorePromptBannerFileClick = () => {};
const THREAD_DETAIL_COMPOSER_TEXTAREA_ID = "thread-detail-follow-up-composer";
const EMPTY_QUEUED_MESSAGES: readonly ThreadQueuedMessage[] = [];

interface ThreadDetailPromptAreaProps {
  canRestoreEnvironment: boolean;
  canUseGitUi: boolean;
  contextWindowUsage?: ThreadTimelineResponse["contextWindowUsage"];
  environmentCheckout?: WorkspaceCheckoutDisplay;
  environmentCompactLabel?: string;
  environmentGoneStatus: "destroyed" | MachineRemovalStatus | null;
  environmentHostId?: string;
  environmentHost?: MachineLabelHost;
  environmentIcon?: IconName;
  environmentLabel?: string;
  environmentProviderName?: string;
  onCreateNewThreadInEnvironment?: () => void;
  pendingInteractions: readonly PendingInteraction[];
  pendingInteractionsInitialLoading: boolean;
  onChangedFileClick: (selection: WorkspaceChangedFileSelection) => void;
  projectId: string;
  resolveMentionLink: PromptMentionLinkResolver;
  workspaceChangedFilesSection: WorkspaceChangedFilesSection | null;
  workspaceStatusPending: boolean;
  contextBannerMergeBase: ContextBannerMergeBaseConfig | null;
  pendingTodos: ThreadTimelinePendingTodos | null;
  activePromptMode: ThreadTimelineActivePromptMode | null;
  modelFallback: ThreadTimelineModelFallback | null;
  parentThreadSection: ThreadPromptParentThreadSection | null;
  childPendingInteractions: readonly ChildThreadPendingAttention[];
  childThreadsSection: ThreadPromptChildThreadsSection | null;
  sendMessage: SendMessageMutationLike;
  steerActiveThreadOnEnter: boolean;
  composerFocusRequestNonce: number;
  thread: ThreadWithRuntime;
}

export function ThreadDetailPromptArea({
  canRestoreEnvironment,
  canUseGitUi,
  contextWindowUsage,
  environmentCheckout,
  environmentCompactLabel,
  environmentGoneStatus,
  environmentHostId,
  environmentHost,
  environmentIcon,
  environmentLabel,
  environmentProviderName,
  onCreateNewThreadInEnvironment,
  pendingInteractions,
  pendingInteractionsInitialLoading,
  onChangedFileClick,
  projectId,
  resolveMentionLink,
  workspaceChangedFilesSection,
  workspaceStatusPending,
  contextBannerMergeBase,
  pendingTodos,
  activePromptMode,
  modelFallback,
  parentThreadSection,
  childPendingInteractions,
  childThreadsSection,
  sendMessage,
  steerActiveThreadOnEnter,
  composerFocusRequestNonce,
  thread,
}: ThreadDetailPromptAreaProps) {
  const defaultExecutionOptionsQuery = useThreadDefaultExecutionOptions(
    thread.id,
    { enabled: true },
  );
  const defaultExecutionOptions = defaultExecutionOptionsQuery.data;
  const verifiedDefaultExecutionOptions =
    defaultExecutionOptionsQuery.isPlaceholderData
      ? undefined
      : defaultExecutionOptions;
  const hasConcreteDefaultExecutionOptions =
    verifiedDefaultExecutionOptions !== undefined &&
    verifiedDefaultExecutionOptions !== null;
  const isDefaultExecutionOptionsLoading =
    resolveDefaultExecutionOptionsState({
      hasConcreteDefaultExecutionOptions,
      hasResolvedDefaultExecutionOptions:
        verifiedDefaultExecutionOptions !== undefined,
      isError: defaultExecutionOptionsQuery.isError,
    }) === "loading";
  const queuedMessages =
    useThreadQueuedMessages(thread.id, { enabled: true }).data ??
    EMPTY_QUEUED_MESSAGES;
  const {
    inlineEditingQueuedMessage,
    dismissInlineQueuedMessageEditor,
    beginEditQueuedMessage,
    queuedMessageDraftSession,
  } = useInlineQueuedMessageEditing({
    ownerThreadId: thread.id,
    queuedMessages,
  });
  const inlineDraftSessionRef = useLatestRef(queuedMessageDraftSession);
  const { data: promptHistoryEntries = [] } = useThreadPromptHistory(thread.id);
  const createQueuedMessage = useCreateThreadQueuedMessage();
  const stopThread = useStopThread();
  const cancelThreadPlan = useCancelThreadPlan();
  const unarchiveThread = useUnarchiveThread();
  const restoreThreadEnvironment = useRestoreThreadEnvironment();
  const projectName = useProjectDisplayName(
    thread.projectId === PERSONAL_PROJECT_ID ? undefined : thread.projectId,
  );
  const {
    promptDraft,
    currentPromptDraft,
    currentPromptDraftInput,
    activeComposerDraft,
    activeComposerDraftInput,
    handleChangeMessage,
    removeActiveComposerAttachment,
  } = useActiveComposerDraft({
    draftScope: { kind: "thread", projectId, threadId: thread.id },
    inlineDraft: inlineEditingQueuedMessage?.draft ?? null,
    inlineSessionRef: inlineDraftSessionRef,
  });
  const uploads = useComposerAttachmentUploads({
    projectId,
    addDraftAttachment: promptDraft.addAttachment,
    inlineEditSessionId: queuedMessageDraftSession?.editSessionId ?? null,
    inlineSessionRef: inlineDraftSessionRef,
  });
  const [expandedBannerSection, setExpandedBannerSection] =
    useState<ThreadPromptContextBannerExpandedSection | null>(null);
  const [isTodoExpanded, setIsTodoExpanded] = useState(false);
  const [isPromptModeExpanded, setIsPromptModeExpanded] = useState(false);
  const [isFollowUpShortcutSending, setIsFollowUpShortcutSending] =
    useState(false);
  const {
    execution: baseExecution,
    permission: basePermission,
    selectedProviderComposerActions,
    selectedModel,
    serviceTier,
    reasoningLevel,
    activeModel,
    supportsServiceTier,
    executionInputSources,
  } = useThreadCreationOptions({
    enabled: thread.archivedAt === null,
    environmentId: thread.environmentId ?? undefined,
    environmentHostId,
    scope: "component-local",
    resetKey: thread.id,
    initialProviderId: thread.providerId,
    initialModel:
      modelFallback?.fallbackModel ?? defaultExecutionOptions?.model,
    initialServiceTier: defaultExecutionOptions?.serviceTier,
    initialReasoningLevel: defaultExecutionOptions?.reasoningLevel,
    initialPermissionMode: defaultExecutionOptions?.permissionMode,
  });
  const fallbackIdentity = modelFallback
    ? `${thread.id}:${modelFallback.sourceSeq}`
    : null;
  const [overriddenFallbackIdentity, setOverriddenFallbackIdentity] = useState<
    string | null
  >(null);
  const effectiveSelectedModel =
    modelFallback !== null && overriddenFallbackIdentity !== fallbackIdentity
      ? modelFallback.fallbackModel
      : (activeModel?.model ?? selectedModel);
  const typeaheadArgs = {
    projectId: thread.projectId,
    mentionsProjectId: projectId,
    providerId: thread.providerId,
    environmentId: thread.environmentId,
    currentThreadId: thread.id,
    selectedProviderComposerActions,
    resolveMentionLink,
  };
  const { typeaheadConfig, promptActions } =
    useComposerTypeahead(typeaheadArgs);
  const inlineTypeahead = useComposerTypeahead(typeaheadArgs);
  const runtimeDisplayStatus = thread.runtime.displayStatus;
  const shouldSteerWhenReady =
    runtimeDisplayStatus === "provisioning" ||
    runtimeDisplayStatus === "starting";
  const isStopRequested =
    thread.status === "stopping" ||
    (stopThread.isPending && stopThread.variables === thread.id);
  const activePendingInteraction =
    getLatestPendingInteraction(pendingInteractions);
  const shouldHideComposer =
    environmentGoneStatus !== null || thread.archivedAt !== null;
  const {
    processingQueuedMessage,
    queuedMessageActionPending,
    isUpdateQueuedMessagePending,
    sendQueuedMessageById,
    handleSaveInlineQueuedMessage,
    handleDeleteQueuedMessage,
  } = useQueuedMessageActions({
    threadId: thread.id,
    queuedMessages,
    sendProcessingPersistence: "until-left-queue",
    inlineEditingQueuedMessage,
    dismissInlineQueuedMessageEditor,
    activeComposerDraftInput,
  });
  const isQueueMutationPending =
    createQueuedMessage.isPending ||
    queuedMessageActionPending ||
    isFollowUpShortcutSending;
  const isFollowUpSubmitting =
    sendMessage.isPending ||
    createQueuedMessage.isPending ||
    isFollowUpShortcutSending;
  const submitMode = buildFollowUpSubmitMode({
    hasPendingInteraction: activePendingInteraction !== null,
    isDefaultExecutionOptionsLoading,
    isPendingInteractionsInitialLoading: pendingInteractionsInitialLoading,
    isStopRequested,
    onStop: () => stopThread.mutate(thread.id),
    runtimeDisplayStatus,
  });
  const placeholderStatus = isStopRequested ? "stopping" : runtimeDisplayStatus;
  const promptPlaceholder = getFollowUpPromptPlaceholder(placeholderStatus);
  const compactPromptPlaceholder =
    getCompactFollowUpPromptPlaceholder(placeholderStatus);
  const canSubmitModifierShortcut =
    !shouldHideComposer &&
    canSubmitFollowUpShortcut({
      hasPromptDraftInput: currentPromptDraftInput.length > 0,
      isFollowUpSubmitting,
      isQueueMutationPending,
      queuedMessageCount: queuedMessages.length,
      runtimeDisplayStatus,
      submitModeKind: submitMode.kind,
    });
  const followUpExecutionSelection: FollowUpExecutionSelection =
    hasConcreteDefaultExecutionOptions
      ? {
          model: effectiveSelectedModel,
          supportsServiceTier,
          serviceTier,
          reasoningLevel,
          permissionMode: basePermission.value,
          executionInputSources,
        }
      : null;
  const restoreFailedDraft =
    (submittedDraft: typeof currentPromptDraft, queued: boolean) =>
    (error: unknown) => {
      promptDraft.restoreIfEmpty(submittedDraft);
      showMutationErrorToast({
        error,
        fallbackMessage: queued
          ? "Failed to queue message"
          : "Failed to send message",
        lifecycleOperation: queued ? "queue_message" : "send_message",
      });
    };

  const handleSend = () => {
    const isQueuingMessage = shouldQueueFollowUpMessage(runtimeDisplayStatus);
    if (
      currentPromptDraftInput.length === 0 ||
      (!isQueuingMessage && isDefaultExecutionOptionsLoading)
    ) {
      return;
    }
    const request = {
      threadId: thread.id,
      input: currentPromptDraftInput,
      execution: followUpExecutionSelection,
    };
    const queuedRequest = isQueuingMessage
      ? buildCreateQueuedFollowUpRequest(request)
      : null;
    const sendRequest = isQueuingMessage
      ? null
      : buildAutoFollowUpRequest(request);
    promptDraft.clearIfCurrentMatches(currentPromptDraft);
    uploads.setBottomAttachmentError(null);
    const pending = queuedRequest
      ? createQueuedMessage.mutateAsync(queuedRequest)
      : sendRequest
        ? sendMessage.mutateAsync(sendRequest)
        : null;
    pending?.catch(restoreFailedDraft(currentPromptDraft, isQueuingMessage));
  };
  const handleModifierSubmit = () => {
    const shortcutRequest = canSubmitModifierShortcut
      ? buildFollowUpShortcutRequest({
          execution: followUpExecutionSelection,
          input: currentPromptDraftInput,
          queuedMessages,
          threadId: thread.id,
        })
      : null;
    if (!shortcutRequest) return;
    setIsFollowUpShortcutSending(true);
    if (shortcutRequest.kind === "draft") {
      promptDraft.clearIfCurrentMatches(currentPromptDraft);
      uploads.setBottomAttachmentError(null);
    }
    void (
      shortcutRequest.kind === "draft"
        ? sendMessage
            .mutateAsync(shortcutRequest.request)
            .catch(restoreFailedDraft(currentPromptDraft, false))
        : sendQueuedMessageById({
            guard: "current-head",
            messageId: shortcutRequest.request.queuedMessageId,
            mode: shortcutRequest.request.mode,
          })
    ).then(() => setIsFollowUpShortcutSending(false));
  };

  const execution: FollowUpPromptBoxProps["execution"] = {
    ...baseExecution,
    provider: {
      ...baseExecution.provider,
      selectedId: thread.providerId,
      onChange: undefined,
    },
    model: {
      ...baseExecution.model,
      active: effectiveSelectedModel ? { model: effectiveSelectedModel } : null,
      onChange: (model) => {
        setOverriddenFallbackIdentity(fallbackIdentity);
        baseExecution.model.onChange(model);
      },
    },
  };
  const permission: FollowUpPromptBoxProps["permission"] =
    hasConcreteDefaultExecutionOptions
      ? basePermission
      : { ...basePermission, value: undefined, options: [], supported: false };

  const promptModeCard = (
    <ThreadPromptModeCard
      activePromptMode={activePromptMode}
      isExitPending={cancelThreadPlan.isPending}
      isExpanded={isPromptModeExpanded}
      onExitPlanMode={() => cancelThreadPlan.mutate(thread.id)}
      onToggle={() => setIsPromptModeExpanded((value) => !value)}
    />
  );
  const inlineEditor: QueuedMessageInlineEditor | undefined =
    inlineEditingQueuedMessage
      ? {
          queuedMessageId: inlineEditingQueuedMessage.queuedMessageId,
          queuedMessageIndex: inlineEditingQueuedMessage.queuedMessageIndex,
          onDismiss: dismissInlineQueuedMessageEditor,
          content: (
            <FollowUpPromptBox
              id={`${THREAD_DETAIL_COMPOSER_TEXTAREA_ID}-queued-${inlineEditingQueuedMessage.queuedMessageId}`}
              attachments={{
                items: activeComposerDraft.attachments,
                projectId,
                isAttaching: uploads.isAttachingInlineFiles,
                pendingUploads: uploads.inlinePendingUploads,
                error: uploads.inlineAttachmentError,
                onAttachFiles: uploads.handleAttachInlineFiles,
                onRemove: removeActiveComposerAttachment,
              }}
              stack={null}
              composer={{
                isFollowUpSubmitting: isUpdateQueuedMessagePending,
                message: activeComposerDraft.text,
                mentionRanges: activeComposerDraft.mentions,
                onChangeMessage: handleChangeMessage,
                onModifierSubmit: () => void handleSaveInlineQueuedMessage(),
                onSubmit: () => void handleSaveInlineQueuedMessage(),
                compactPromptPlaceholder,
                promptPlaceholder,
                canModifierSubmit:
                  activeComposerDraftInput.length > 0 &&
                  !isUpdateQueuedMessagePending,
                steerActiveThreadOnEnter: false,
                submitMode: { kind: "ready" },
                threadRuntimeDisplayStatus: runtimeDisplayStatus,
              }}
              environmentSummary={null}
              contextWindowUsage={null}
              execution={{
                ...execution,
                model: {
                  ...execution.model,
                  active: { model: inlineEditingQueuedMessage.model },
                  selected: inlineEditingQueuedMessage.model,
                },
                serviceTier: baseExecution.serviceTier && {
                  ...baseExecution.serviceTier,
                  value: inlineEditingQueuedMessage.serviceTier,
                },
                reasoning: {
                  ...execution.reasoning,
                  value: inlineEditingQueuedMessage.reasoningLevel,
                },
              }}
              executionReadOnly
              permission={{
                ...permission,
                value: inlineEditingQueuedMessage.permissionMode,
              }}
              permissionReadOnly
              typeahead={inlineTypeahead.typeaheadConfig}
              promptActions={inlineTypeahead.promptActions}
              preferExpanded
              focusEndKey={inlineEditingQueuedMessage.editSessionId}
              isPrimaryComposer={false}
              showScrollToBottomButton={false}
            />
          ),
        }
      : undefined;
  const childPendingInteractionBanners = childPendingInteractions.map(
    (item) => (
      <ThreadPendingInteractionBanner
        key={item.interaction.id}
        interaction={item.interaction}
        sourceThread={{ href: item.href, title: item.childTitle }}
        threadId={item.childThreadId}
      />
    ),
  );
  const pendingInteractionNode =
    activePendingInteraction && !shouldHideComposer ? (
      <ThreadPendingInteractionBanner
        interaction={activePendingInteraction}
        threadId={thread.id}
      />
    ) : null;
  const promptStack = pendingInteractionNode ? (
    <>
      {childPendingInteractionBanners}
      {activePromptMode ? promptModeCard : null}
    </>
  ) : (
    <>
      {childPendingInteractionBanners}
      {shouldHideComposer ? null : promptModeCard}
      <ThreadTodoCard
        pendingTodos={shouldHideComposer ? null : pendingTodos}
        isExpanded={isTodoExpanded}
        onToggle={() => setIsTodoExpanded((value) => !value)}
      />
      <ThreadPromptContextBanner
        archivedSection={
          thread.archivedAt !== null
            ? {
                archivedAt: thread.archivedAt,
                onUnarchive: () => unarchiveThread.mutate({ id: thread.id }),
                unarchivePending:
                  unarchiveThread.isPending &&
                  unarchiveThread.variables?.id === thread.id,
              }
            : null
        }
        environmentGoneSection={
          environmentGoneStatus === null
            ? null
            : {
                status: environmentGoneStatus,
                ...(canRestoreEnvironment
                  ? {
                      onRestore: () =>
                        restoreThreadEnvironment.mutate({ id: thread.id }),
                      restorePending:
                        restoreThreadEnvironment.isPending &&
                        restoreThreadEnvironment.variables?.id === thread.id,
                    }
                  : {}),
              }
        }
        parentThreadSection={parentThreadSection}
        childThreadsSection={childThreadsSection}
        gitSection={
          workspaceChangedFilesSection
            ? {
                changedFiles: workspaceChangedFilesSection,
                mergeBase: contextBannerMergeBase,
                onPromptBannerFileClick: canUseGitUi
                  ? onChangedFileClick
                  : ignorePromptBannerFileClick,
              }
            : null
        }
        gitSectionPending={workspaceStatusPending}
        expandedSection={expandedBannerSection}
        onToggleSection={(section) =>
          setExpandedBannerSection((previous) =>
            previous === section ? null : section,
          )
        }
      />
      {shouldHideComposer ? null : (
        <QueuedMessagesList
          attachedToComposer={true}
          queuedMessages={queuedMessages}
          resolveMentionLink={resolveMentionLink}
          inlineEditor={inlineEditor}
          sendAction={shouldSteerWhenReady ? "steer-when-ready" : "send-now"}
          sendDisabled={
            submitMode.kind === "blocked" ||
            runtimeDisplayStatus === "waiting-for-host" ||
            isFollowUpSubmitting ||
            isQueueMutationPending
          }
          actionDisabled={isQueueMutationPending}
          processingMessageId={processingQueuedMessage?.id ?? null}
          processingAction={processingQueuedMessage?.action ?? null}
          onSend={(messageId) =>
            void sendQueuedMessageById({
              guard: "exists",
              messageId,
              mode: shouldSteerWhenReady ? "steer" : "auto",
            })
          }
          onEdit={beginEditQueuedMessage}
          onDelete={handleDeleteQueuedMessage}
        />
      )}
    </>
  );

  return (
    <FollowUpPromptBox
      id={THREAD_DETAIL_COMPOSER_TEXTAREA_ID}
      attachments={{
        items: currentPromptDraft.attachments,
        projectId,
        isAttaching: uploads.isAttachingBottomFiles,
        pendingUploads: uploads.bottomPendingUploads,
        error: uploads.bottomAttachmentError,
        onAttachFiles: uploads.handleAttachBottomFiles,
        onRemove: promptDraft.removeAttachment,
      }}
      stack={promptStack}
      pendingInteraction={pendingInteractionNode}
      activePromptMode={activePromptMode}
      composer={
        shouldHideComposer
          ? null
          : {
              history: {
                currentDraft: currentPromptDraft,
                entries: promptHistoryEntriesToDrafts(promptHistoryEntries),
                onSelectEntry: promptDraft.setDraft,
                resetKey: thread.id,
              },
              isFollowUpSubmitting,
              message: currentPromptDraft.text,
              mentionRanges: currentPromptDraft.mentions,
              onChangeMessage: promptDraft.setTextAndMentions,
              onModifierSubmit: handleModifierSubmit,
              onSubmit: handleSend,
              compactPromptPlaceholder,
              promptPlaceholder,
              canModifierSubmit: canSubmitModifierShortcut,
              steerActiveThreadOnEnter,
              submitMode,
              threadRuntimeDisplayStatus: runtimeDisplayStatus,
            }
      }
      focusEndKey={composerFocusRequestNonce}
      environmentSummary={
        thread.environmentId !== null ? (
          <ThreadEnvironmentSummary
            projectName={projectName}
            environmentLabel={environmentLabel}
            environmentCompactLabel={environmentCompactLabel}
            environmentHost={environmentHost}
            environmentIcon={environmentIcon}
            environmentProviderName={environmentProviderName}
            environmentCheckout={environmentCheckout}
            onCreateNewThreadInEnvironment={onCreateNewThreadInEnvironment}
          />
        ) : null
      }
      contextWindowUsage={contextWindowUsage ?? null}
      execution={execution}
      permission={permission}
      typeahead={typeaheadConfig}
      promptActions={promptActions}
    />
  );
}
