import type {
  PermissionMode,
  PromptInput,
  ReasoningLevel,
  ServiceTier,
  ThreadRuntimeDisplayStatus,
} from "@bb/domain";
import type {
  CreateQueuedMessageRequest,
  ExistingThreadExecutionInputSources,
  SendMessageRequest,
} from "@bb/server-contract";

export type FollowUpSubmitMode =
  | { kind: "ready" }
  | { kind: "queue"; onStop: () => void }
  | { kind: "queue-while-stopping" }
  | {
      kind: "blocked";
      reason:
        | "loading-execution-options"
        | "loading-pending-interactions"
        | "pending-interaction"
        | "unavailable";
    };

export type FollowUpExecutionSelection = {
  model: string;
  permissionMode: PermissionMode;
  reasoningLevel: ReasoningLevel;
  serviceTier: ServiceTier | undefined;
  supportsServiceTier: boolean;
  executionInputSources: ExistingThreadExecutionInputSources;
} | null;

interface FollowUpRequestArgs {
  execution: FollowUpExecutionSelection;
  input: PromptInput[];
  threadId: string;
}

type SendMessageMutationRequest = SendMessageRequest & { id: string };

export function shouldQueueFollowUpMessage(
  displayStatus: ThreadRuntimeDisplayStatus,
): boolean {
  return (
    displayStatus === "active" ||
    displayStatus === "provisioning" ||
    displayStatus === "starting" ||
    displayStatus === "stopping" ||
    displayStatus === "waiting-for-host"
  );
}

export function buildFollowUpSubmitMode(args: {
  hasPendingInteraction: boolean;
  isDefaultExecutionOptionsLoading: boolean;
  isPendingInteractionsInitialLoading: boolean;
  isStopRequested: boolean;
  onStop: () => void;
  runtimeDisplayStatus: ThreadRuntimeDisplayStatus;
}): FollowUpSubmitMode {
  if (args.isStopRequested) return { kind: "queue-while-stopping" };
  if (args.isPendingInteractionsInitialLoading) {
    return { kind: "blocked", reason: "loading-pending-interactions" };
  }
  if (args.hasPendingInteraction) {
    return { kind: "blocked", reason: "pending-interaction" };
  }
  if (shouldQueueFollowUpMessage(args.runtimeDisplayStatus)) {
    return { kind: "queue", onStop: args.onStop };
  }
  return args.isDefaultExecutionOptionsLoading
    ? { kind: "blocked", reason: "loading-execution-options" }
    : { kind: "ready" };
}

export function canSubmitFollowUpShortcut(args: {
  hasPromptDraftInput: boolean;
  isFollowUpSubmitting: boolean;
  isQueueMutationPending: boolean;
  queuedMessageCount: number;
  runtimeDisplayStatus: ThreadRuntimeDisplayStatus;
  submitModeKind: FollowUpSubmitMode["kind"];
}): boolean {
  const { runtimeDisplayStatus: status, submitModeKind } = args;
  if (args.isFollowUpSubmitting || args.isQueueMutationPending) return false;
  const canSteerActiveWork =
    (status === "active" ||
      status === "provisioning" ||
      status === "starting") &&
    submitModeKind === "queue";
  return args.hasPromptDraftInput
    ? canSteerActiveWork ||
        (status === "waiting-for-host" && submitModeKind === "queue")
    : args.queuedMessageCount > 0 &&
        (canSteerActiveWork ||
          (status === "idle" && submitModeKind === "ready"));
}

export function resolveDefaultExecutionOptionsState(args: {
  hasConcreteDefaultExecutionOptions: boolean;
  hasResolvedDefaultExecutionOptions: boolean;
  isError: boolean;
}): "available" | "loading" | "unavailable" {
  if (args.hasConcreteDefaultExecutionOptions) return "available";
  return args.hasResolvedDefaultExecutionOptions || args.isError
    ? "unavailable"
    : "loading";
}

function executionRequestFields(execution: FollowUpExecutionSelection) {
  if (execution === null) return {};
  return {
    model: execution.model,
    ...(execution.supportsServiceTier && execution.serviceTier
      ? { serviceTier: execution.serviceTier }
      : {}),
    reasoningLevel: execution.reasoningLevel,
    permissionMode: execution.permissionMode,
    executionInputSources: execution.executionInputSources,
  };
}

function buildSendRequest(
  { execution, input, threadId }: FollowUpRequestArgs,
  mode: "queue-if-active" | "steer-if-active",
): SendMessageMutationRequest | null {
  return input.length === 0
    ? null
    : { id: threadId, input, mode, ...executionRequestFields(execution) };
}

export function buildAutoFollowUpRequest(
  args: FollowUpRequestArgs,
): SendMessageMutationRequest | null {
  return buildSendRequest(args, "queue-if-active");
}

export function buildCreateQueuedFollowUpRequest({
  execution,
  input,
  threadId,
}: FollowUpRequestArgs): (CreateQueuedMessageRequest & { id: string }) | null {
  return input.length === 0
    ? null
    : { id: threadId, input, ...executionRequestFields(execution) };
}

export function buildFollowUpShortcutRequest(
  args: FollowUpRequestArgs & { queuedMessages: readonly { id: string }[] },
):
  | { kind: "draft"; request: SendMessageMutationRequest }
  | {
      kind: "queued";
      request: { id: string; mode: "steer"; queuedMessageId: string };
    }
  | null {
  const draftRequest = buildSendRequest(args, "steer-if-active");
  if (draftRequest) return { kind: "draft", request: draftRequest };
  const queuedMessageId = args.queuedMessages[0]?.id;
  return queuedMessageId === undefined
    ? null
    : {
        kind: "queued",
        request: { id: args.threadId, mode: "steer", queuedMessageId },
      };
}
