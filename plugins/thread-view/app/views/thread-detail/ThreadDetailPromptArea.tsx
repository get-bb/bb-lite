import type { MachineRemovalStatus } from "@bb/app-kit/lib/machine-removal-display";
import { useState } from "react";
import type { IconName } from "@bb/shared-ui/icon";
import type { PromptMentionLinkResolver } from "@bb/app-kit/components/promptbox/editor/prompt-mention-link";
import {
  getFollowUpPromptPlaceholder,
  getCompactFollowUpPromptPlaceholder,
} from "../../components/promptbox/follow-up-placeholder";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import type {
  PendingInteraction,
  ThreadQueuedMessage,
  ThreadTimelineModelFallback,
  ThreadTimelinePendingTodos,
  ThreadWithRuntime,
} from "@bb/domain";
import type {
  ThreadTimelineResponse,
  TimelineWorkflowWorkRow,
} from "@bb/server-contract";
import type { ChildThreadPendingAttention } from "../../hooks/queries/child-thread-pending-interactions";
import { ThreadPendingInteractionBanner } from "../../components/thread/pending-interactions/ThreadPendingInteractionBanner";
import {
  ThreadPromptContextBanner,
  type ContextBannerMergeBaseConfig,
  type ThreadPromptContextBannerExpandedSection,
  type ThreadPromptParentThreadSection,
  type ThreadPromptChildThreadsSection,
} from "bb-plugin-composer/contract";
import { ThreadTodoCard } from "bb-plugin-composer/contract";
import { ThreadWorkflowCard } from "bb-plugin-composer/contract";
import { ThreadBackgroundCommandsCard } from "bb-plugin-composer/contract";
import { ThreadModelFallbackCard } from "bb-plugin-composer/contract";
import { ThreadPrivateMachineCard } from "bb-plugin-composer/contract";
import type {
  WorkspaceChangedFileSelection,
  WorkspaceChangedFilesSection,
} from "@bb/app-kit/components/workspace/workspace-change-summary";
import {
  QueuedMessagesList,
  type QueuedMessageEditRequest,
  type QueuedMessageInlineEditor,
  type QueuedMessageProcessingAction,
} from "bb-plugin-composer/contract";
import { ThreadEnvironmentSummary } from "bb-plugin-composer/contract";
import type { MachineLabelHost } from "@bb/app-kit/components/machines/MachineLabel";
import type { WorkspaceCheckoutDisplay } from "@bb/app-kit/lib/workspace-checkout-display";
import { useThreadCreationOptions } from "bb-plugin-composer/contract";
import { useHosts } from "@bb/app-kit/hooks/queries/host-queries";
import { useProjectDisplayName } from "@bb/app-kit/hooks/queries/sidebar-navigation-query";
import { useUserDirectory } from "@bb/app-kit/hooks/queries/user-queries";
import {
  isHostUsable,
  privateMachineThreadNotice,
} from "@bb/app-kit/lib/machine-access";
import { useDraftAttachmentUploads } from "bb-plugin-composer/contract";
import { usePromptTypeahead } from "bb-plugin-composer/contract";
import { usePromptDraftStorage } from "bb-plugin-composer/contract";
import {
  useCreateThreadQueuedMessage,
  useDeleteThreadQueuedMessage,
  useSendThreadQueuedMessage,
  useStopThread,
  useUpdateThreadQueuedMessage,
} from "@bb/app-kit/hooks/mutations/thread-runtime-mutations";
import { useUnarchiveThread } from "@bb/app-kit/hooks/mutations/thread-state-mutations";
import {
  getLatestPendingInteraction,
  useThreadQueuedMessages,
  useThreadPromptHistory,
} from "@bb/app-kit/hooks/queries/thread-queries";
import { useThreadDefaultExecutionOptions } from "../../hooks/queries/thread-default-execution-options-query";
import { showMutationErrorToast } from "@bb/app-kit/lib/mutation-errors";
import { BbHttpError } from "@bb/app-kit/lib/sdk";
import { promptHistoryEntriesToDrafts } from "bb-plugin-composer/contract";
import {
  FollowUpPromptBox,
  type FollowUpPromptBoxProps,
} from "bb-plugin-composer/contract";
import type { SendMessageMutationLike } from "./threadDetailMutationTypes";
import {
  buildAutoFollowUpRequest,
  buildCreateQueuedFollowUpRequest,
  buildFollowUpSubmitMode,
  buildFollowUpShortcutRequest,
  canSubmitFollowUpShortcut,
  promptDraftToInput,
  queuedInputToDraft,
  resolveDefaultExecutionOptionsState,
  shouldQueueFollowUpMessage,
  type FollowUpExecutionSelection,
  type PromptDraftState,
} from "@bb/client-core";
import type { SendQueuedMessageMode } from "@bb/server-contract";

const ignorePromptBannerFileClick = () => {};
const THREAD_DETAIL_COMPOSER_TEXTAREA_ID = "thread-detail-follow-up-composer";
const EMPTY_QUEUED_MESSAGES: readonly ThreadQueuedMessage[] = [];

interface InlineQueuedMessageEdit {
  threadId: string;
  sessionId: number;
  queuedMessage: ThreadQueuedMessage;
  queuedMessageIndex: number;
  draft: PromptDraftState;
}

interface ThreadDetailPromptAreaProps {
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
  modelFallback: ThreadTimelineModelFallback | null;
  activeWorkflows: TimelineWorkflowWorkRow[];
  activeBackgroundCommands: TimelineWorkflowWorkRow[];
  parentThreadSection: ThreadPromptParentThreadSection | null;
  childPendingInteractions: readonly ChildThreadPendingAttention[];
  childThreadsSection: ThreadPromptChildThreadsSection | null;
  sendMessage: SendMessageMutationLike;
  steerActiveThreadOnEnter: boolean;
  composerFocusRequestNonce: number;
  thread: ThreadWithRuntime;
}

export function ThreadDetailPromptArea({
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
  modelFallback,
  activeWorkflows,
  activeBackgroundCommands,
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
  const [inlineEditState, setInlineEdit] =
    useState<InlineQueuedMessageEdit | null>(null);
  const inlineEdit =
    inlineEditState?.threadId === thread.id &&
    queuedMessages.some(
      (message) => message.id === inlineEditState.queuedMessage.id,
    )
      ? inlineEditState
      : null;
  const inlineInput = inlineEdit ? promptDraftToInput(inlineEdit.draft) : [];
  const updateInlineDraft = (
    update: (draft: PromptDraftState) => PromptDraftState,
  ) =>
    setInlineEdit(
      (current) => current && { ...current, draft: update(current.draft) },
    );
  const beginEditQueuedMessage = (request: QueuedMessageEditRequest) => {
    const queuedMessage = queuedMessages.find(
      (message) => message.id === request.queuedMessageId,
    );
    if (!queuedMessage) return;
    setInlineEdit({
      threadId: thread.id,
      sessionId: (inlineEditState?.sessionId ?? 0) + 1,
      queuedMessage,
      queuedMessageIndex: request.queuedMessageIndex,
      draft: queuedInputToDraft(queuedMessage.content),
    });
  };
  const { data: promptHistoryEntries = [] } = useThreadPromptHistory(thread.id);
  const createQueuedMessage = useCreateThreadQueuedMessage();
  const updateQueuedMessage = useUpdateThreadQueuedMessage();
  const sendQueuedMessage = useSendThreadQueuedMessage();
  const deleteQueuedMessage = useDeleteThreadQueuedMessage();
  const stopThread = useStopThread();
  const unarchiveThread = useUnarchiveThread();
  const threadHost =
    useHosts({ enabled: environmentHostId !== undefined }).data?.find(
      (host) => host.id === environmentHostId,
    ) ?? null;
  const users = useUserDirectory();
  const privateMachineNotice =
    threadHost !== null && !isHostUsable(threadHost)
      ? privateMachineThreadNotice(threadHost, users)
      : null;
  const projectName = useProjectDisplayName(
    thread.projectId === PERSONAL_PROJECT_ID ? undefined : thread.projectId,
  );
  const promptDraft = usePromptDraftStorage({
    kind: "thread",
    projectId,
    threadId: thread.id,
  });
  const currentPromptDraft = {
    text: promptDraft.text,
    mentions: promptDraft.mentions,
    attachments: promptDraft.attachments,
  };
  const currentPromptDraftInput = promptDraftToInput(currentPromptDraft);
  const uploads = useDraftAttachmentUploads(projectId, {
    key: "bottom",
    addAttachment: promptDraft.addAttachment,
  });
  const inlineUploads = useDraftAttachmentUploads(
    projectId,
    inlineEdit && {
      key: String(inlineEdit.sessionId),
      addAttachment: (attachment) =>
        updateInlineDraft((draft) =>
          draft.attachments.some((item) => item.path === attachment.path)
            ? draft
            : { ...draft, attachments: [...draft.attachments, attachment] },
        ),
    },
  );
  const [processing, setProcessing] = useState<{
    id: string;
    action: QueuedMessageProcessingAction;
  } | null>(null);
  const processingQueuedMessage =
    processing && queuedMessages.some((message) => message.id === processing.id)
      ? processing
      : null;
  const clearProcessing = (id: string) =>
    setProcessing((current) => (current?.id === id ? null : current));
  const [expandedBannerSection, setExpandedBannerSection] =
    useState<ThreadPromptContextBannerExpandedSection | null>(null);
  const [isTodoExpanded, setIsTodoExpanded] = useState(false);
  const [expandedWorkflowIds, setExpandedWorkflowIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [isBackgroundCommandsExpanded, setIsBackgroundCommandsExpanded] =
    useState(false);
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
    enabled: thread.archivedAt === null && privateMachineNotice === null,
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
    commandScope: "thread" as const,
    environmentId: thread.environmentId,
    currentThreadId: thread.id,
    composerActions: selectedProviderComposerActions,
    resolveMentionLink,
  };
  const { typeahead, promptActions } = usePromptTypeahead(typeaheadArgs);
  const inlineTypeahead = usePromptTypeahead(typeaheadArgs);
  const runtimeDisplayStatus = thread.runtime.displayStatus;
  const shouldSteerWhenReady =
    runtimeDisplayStatus === "provisioning" ||
    runtimeDisplayStatus === "starting";
  const isStopRequested =
    thread.status === "stopping" ||
    (stopThread.isPending && stopThread.variables === thread.id);
  const activePendingInteraction =
    getLatestPendingInteraction(pendingInteractions);
  const machineGone =
    environmentGoneStatus !== null && environmentGoneStatus !== "destroyed";
  const shouldHideComposer =
    machineGone || thread.archivedAt !== null || privateMachineNotice !== null;
  const sendQueuedMessageById = (
    messageId: string,
    mode: SendQueuedMessageMode,
    headOnly: boolean,
  ) => {
    const index = queuedMessages.findIndex(
      (message) => message.id === messageId,
    );
    if (index < 0 || (headOnly && index > 0)) return Promise.resolve();
    setProcessing({ id: messageId, action: "send" });
    return sendQueuedMessage
      .mutateAsync({ id: thread.id, mode, queuedMessageId: messageId })
      .then(
        () => {
          if (mode === "steer") clearProcessing(messageId);
        },
        (error: unknown) => {
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to send queued message",
            lifecycleOperation: "send_queued_message",
          });
          clearProcessing(messageId);
        },
      );
  };
  const saveInlineEdit = () => {
    if (
      !inlineEdit ||
      inlineInput.length === 0 ||
      updateQueuedMessage.isPending
    ) {
      return;
    }
    const { id: queuedMessageId, updatedAt } = inlineEdit.queuedMessage;
    setProcessing({ id: queuedMessageId, action: "edit" });
    void updateQueuedMessage
      .mutateAsync({
        expectedUpdatedAt: updatedAt,
        id: thread.id,
        input: inlineInput,
        queuedMessageId,
      })
      .then(
        () => setInlineEdit(null),
        (error: unknown) => {
          if (error instanceof BbHttpError && error.status === 404) {
            setInlineEdit(null);
          }
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to update queued message",
            lifecycleOperation: "update_queued_message",
          });
        },
      )
      .then(() => clearProcessing(queuedMessageId));
  };
  const handleDeleteQueuedMessage = (queuedMessageId: string) => {
    setProcessing({ id: queuedMessageId, action: "delete" });
    void deleteQueuedMessage
      .mutateAsync({ id: thread.id, queuedMessageId })
      .catch((error: unknown) =>
        showMutationErrorToast({
          error,
          fallbackMessage: "Failed to delete queued message",
          lifecycleOperation: "queue_message",
        }),
      )
      .then(() => clearProcessing(queuedMessageId));
  };
  const isQueueMutationPending =
    createQueuedMessage.isPending ||
    deleteQueuedMessage.isPending ||
    sendQueuedMessage.isPending ||
    updateQueuedMessage.isPending ||
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
    uploads.setAttachmentError(null);
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
      uploads.setAttachmentError(null);
    }
    void (
      shortcutRequest.kind === "draft"
        ? sendMessage
            .mutateAsync(shortcutRequest.request)
            .catch(restoreFailedDraft(currentPromptDraft, false))
        : sendQueuedMessageById(
            shortcutRequest.request.queuedMessageId,
            shortcutRequest.request.mode,
            true,
          )
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

  const inlineEditor: QueuedMessageInlineEditor | undefined = inlineEdit
    ? {
        queuedMessageId: inlineEdit.queuedMessage.id,
        queuedMessageIndex: inlineEdit.queuedMessageIndex,
        onDismiss: () => setInlineEdit(null),
        content: (
          <FollowUpPromptBox
            id={`${THREAD_DETAIL_COMPOSER_TEXTAREA_ID}-queued-${inlineEdit.queuedMessage.id}`}
            attachments={{
              items: inlineEdit.draft.attachments,
              projectId,
              isAttaching: inlineUploads.isAttachingFiles,
              pendingUploads: inlineUploads.pendingUploads,
              error: inlineUploads.attachmentError,
              onAttachFiles: inlineUploads.handleAttachFiles,
              onRemove: (path) =>
                updateInlineDraft((draft) => ({
                  ...draft,
                  attachments: draft.attachments.filter(
                    (attachment) => attachment.path !== path,
                  ),
                })),
            }}
            stack={null}
            composer={{
              isFollowUpSubmitting: updateQueuedMessage.isPending,
              message: inlineEdit.draft.text,
              mentionRanges: inlineEdit.draft.mentions,
              onChangeMessage: (text, mentions) =>
                updateInlineDraft((draft) => ({ ...draft, text, mentions })),
              onModifierSubmit: saveInlineEdit,
              onSubmit: saveInlineEdit,
              compactPromptPlaceholder,
              promptPlaceholder,
              canModifierSubmit:
                inlineInput.length > 0 && !updateQueuedMessage.isPending,
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
                active: { model: inlineEdit.queuedMessage.model },
                selected: inlineEdit.queuedMessage.model,
              },
              serviceTier: baseExecution.serviceTier && {
                ...baseExecution.serviceTier,
                value: inlineEdit.queuedMessage.serviceTier,
              },
              reasoning: {
                ...execution.reasoning,
                value: inlineEdit.queuedMessage.reasoningLevel,
              },
            }}
            executionReadOnly
            permission={{
              ...permission,
              value: inlineEdit.queuedMessage.permissionMode,
            }}
            permissionReadOnly
            typeahead={inlineTypeahead.typeahead}
            promptActions={inlineTypeahead.promptActions}
            preferExpanded
            focusEndKey={inlineEdit.sessionId}
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
    childPendingInteractionBanners
  ) : (
    <>
      {childPendingInteractionBanners}
      {activeWorkflows.map((workflow) => (
        <ThreadWorkflowCard
          key={workflow.id}
          workflow={workflow}
          isExpanded={expandedWorkflowIds.has(workflow.id)}
          onToggle={() =>
            setExpandedWorkflowIds((current) => {
              const next = new Set(current);
              if (!next.delete(workflow.id)) next.add(workflow.id);
              return next;
            })
          }
        />
      ))}
      <ThreadBackgroundCommandsCard
        commands={activeBackgroundCommands}
        isExpanded={isBackgroundCommandsExpanded}
        onToggle={() => setIsBackgroundCommandsExpanded((value) => !value)}
      />
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
            : { status: environmentGoneStatus }
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
      {privateMachineNotice === null ? null : (
        <ThreadPrivateMachineCard message={privateMachineNotice} />
      )}
      {modelFallback ? (
        <ThreadModelFallbackCard
          key={`${thread.id}:${modelFallback.sourceSeq}`}
          fallback={modelFallback}
          threadId={thread.id}
        />
      ) : null}
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
            void sendQueuedMessageById(
              messageId,
              shouldSteerWhenReady ? "steer" : "auto",
              false,
            )
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
      threadId={thread.id}
      attachments={{
        items: currentPromptDraft.attachments,
        projectId,
        isAttaching: uploads.isAttachingFiles,
        pendingUploads: uploads.pendingUploads,
        error: uploads.attachmentError,
        onAttachFiles: uploads.handleAttachFiles,
        onRemove: promptDraft.removeAttachment,
      }}
      stack={promptStack}
      pendingInteraction={pendingInteractionNode}
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
      typeahead={typeahead}
      promptActions={promptActions}
    />
  );
}
