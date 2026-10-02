import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ThreadQueuedMessage } from "@bb/domain";
import type {
  CreateQueuedMessageRequest,
  SendQueuedMessageMode,
  SendQueuedMessageResponse,
  UpdateQueuedMessageRequest,
} from "@bb/server-contract";
import type { AppCreateThreadRequest } from "@bb/client-core";
import { BbHttpError, sdk } from "@/lib/sdk";
import { wsManager } from "@/lib/ws";
import type { SendThreadMessageMutationRequest } from "./mutation-request-types";
import {
  applyCreateThreadResult,
  applyQueuedMessageCreateResult,
  applyQueuedMessageDeleteResult,
  applyQueuedMessageSendResult,
  applyQueuedMessageUpdateResult,
  applySendThreadMessageSuccess,
  applyThreadPlanCancellationResult,
  beginCreateQueuedMessageTransaction,
  beginCreateThreadTransaction,
  beginRemoveQueuedMessageTransaction,
  beginSendQueuedMessageTransaction,
  beginSendThreadMessageTransaction,
  beginStopThreadTransaction,
  beginUpdateQueuedMessageTransaction,
  prefetchThreadQueuedMessages,
  rollbackCreateQueuedMessageTransaction,
  rollbackRemoveQueuedMessageTransaction,
  rollbackSendThreadMessageTransaction,
  rollbackStopThreadTransaction,
  rollbackUpdateQueuedMessageTransaction,
  settleStopThreadTransaction,
  type CreateQueuedMessageTransaction,
  type RemoveQueuedMessageTransaction,
  type SendThreadMessageTransaction,
  type StopThreadTransaction,
  type UpdateQueuedMessageTransaction,
} from "../cache-owners/thread-runtime-cache-owner";
import { invalidateThreadBannerQueries } from "../cache-owners/mutation-cache-effects";

interface CreateThreadQueuedMessageMutationRequest extends CreateQueuedMessageRequest {
  id: string;
}

interface UpdateThreadQueuedMessageMutationRequest extends UpdateQueuedMessageRequest {
  id: string;
  queuedMessageId: string;
}

interface SendThreadQueuedMessageMutationRequest {
  id: string;
  mode: SendQueuedMessageMode;
  queuedMessageId: string;
}

interface DeleteThreadQueuedMessageMutationRequest {
  id: string;
  queuedMessageId: string;
}

function getHttpErrorBodyMessage(error: BbHttpError): string | null {
  const body = error.body;
  if (
    typeof body !== "object" ||
    body === null ||
    !("message" in body) ||
    typeof body.message !== "string"
  ) {
    return null;
  }
  return body.message;
}

function isQueuedMessageNotFoundError(error: unknown): boolean {
  return (
    error instanceof BbHttpError &&
    error.status === 404 &&
    error.code === "invalid_request" &&
    getHttpErrorBodyMessage(error) === "Queued message not found"
  );
}

async function deleteThreadQueuedMessageOrConfirmMissing({
  id,
  queuedMessageId,
}: DeleteThreadQueuedMessageMutationRequest): Promise<void> {
  try {
    await sdk.threads.queuedMessages.delete({ threadId: id, queuedMessageId });
  } catch (error) {
    if (isQueuedMessageNotFoundError(error)) {
      return;
    }
    throw error;
  }
}

export function useCreateThread() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to create thread.",
      lifecycleOperation: "create_thread",
    },
    mutationFn: (request: AppCreateThreadRequest) =>
      sdk.threads.spawn({
        ...request,
        origin: "app",
        originKind: request.originKind ?? null,
        startedOnBehalfOf: request.startedOnBehalfOf ?? null,
      }),
    onMutate: async () => beginCreateThreadTransaction({ queryClient }),
    onSuccess: (thread, variables) => {
      if (thread.queuedMessageCount > 0) {
        void prefetchThreadQueuedMessages({
          queryClient,
          threadId: thread.id,
          load: (signal) =>
            sdk.threads.queuedMessages.list({
              threadId: thread.id,
              signal,
            }),
        });
      }
      applyCreateThreadResult({
        queryClient,
        request: variables,
        thread,
      });
    },
  });
}

export function useSendThreadMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to send message.",
      lifecycleOperation: "send_message",
      showErrorToast: false,
    },
    mutationFn: async ({
      id,
      input,
      model,
      serviceTier,
      reasoningLevel,
      permissionMode,
      mode,
      senderThreadId,
      executionInputSources,
    }: SendThreadMessageMutationRequest) => {
      return await sdk.threads.send({
        threadId: id,
        input,
        model,
        serviceTier,
        reasoningLevel,
        permissionMode,
        executionInputSources,
        mode,
        ...(senderThreadId !== undefined ? { senderThreadId } : {}),
      });
    },
    onMutate: async (variables): Promise<SendThreadMessageTransaction> =>
      beginSendThreadMessageTransaction({
        queryClient,
        request: variables,
      }),
    onError: (_error, variables, context) => {
      rollbackSendThreadMessageTransaction({
        queryClient,
        request: variables,
        transaction: context,
      });
    },
    onSuccess: (data, variables, context) => {
      applySendThreadMessageSuccess({
        queryClient,
        realtimeConnected: wsManager.getConnectionState() === "connected",
        request: variables,
        result: data,
        transaction: context,
      });
    },
  });
}

export function useCreateThreadQueuedMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to queue message.",
      lifecycleOperation: "queue_message",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
      input,
      model,
      serviceTier,
      reasoningLevel,
      permissionMode,
      senderThreadId,
      executionInputSources,
    }: CreateThreadQueuedMessageMutationRequest): Promise<ThreadQueuedMessage> =>
      sdk.threads.queuedMessages.create({
        threadId: id,
        input,
        model,
        serviceTier,
        reasoningLevel,
        permissionMode,
        executionInputSources,
        ...(senderThreadId !== undefined ? { senderThreadId } : {}),
      }),
    onMutate: async (variables): Promise<CreateQueuedMessageTransaction> =>
      beginCreateQueuedMessageTransaction({
        queryClient,
        request: variables,
      }),
    onError: (_error, variables, context) => {
      rollbackCreateQueuedMessageTransaction({
        queryClient,
        request: variables,
        transaction: context,
      });
    },
    onSuccess: (queuedMessage, variables, context) => {
      applyQueuedMessageCreateResult({
        queryClient,
        queuedMessage,
        threadId: variables.id,
        transaction: context,
      });
    },
  });
}

export function useUpdateThreadQueuedMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to update queued message.",
      lifecycleOperation: "update_queued_message",
      showErrorToast: false,
    },
    mutationFn: ({
      expectedUpdatedAt,
      id,
      input,
      queuedMessageId,
    }: UpdateThreadQueuedMessageMutationRequest): Promise<ThreadQueuedMessage> =>
      sdk.threads.queuedMessages.update({
        expectedUpdatedAt,
        input,
        queuedMessageId,
        threadId: id,
      }),
    onMutate: async (variables): Promise<UpdateQueuedMessageTransaction> =>
      beginUpdateQueuedMessageTransaction({
        queryClient,
        request: variables,
      }),
    onError: (_error, variables, context) => {
      rollbackUpdateQueuedMessageTransaction({
        queryClient,
        request: variables,
        transaction: context,
      });
    },
    onSuccess: (queuedMessage, variables) => {
      applyQueuedMessageUpdateResult({
        queryClient,
        queuedMessage,
        threadId: variables.id,
      });
    },
  });
}

export function useSendThreadQueuedMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to send queued message.",
      lifecycleOperation: "send_queued_message",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
      mode,
      queuedMessageId,
    }: SendThreadQueuedMessageMutationRequest): Promise<SendQueuedMessageResponse> =>
      sdk.threads.queuedMessages.send({ threadId: id, queuedMessageId, mode }),
    onMutate: async (variables): Promise<RemoveQueuedMessageTransaction> =>
      beginSendQueuedMessageTransaction({
        queryClient,
        request: variables,
      }),
    onError: (_error, variables, context) => {
      rollbackRemoveQueuedMessageTransaction({
        queryClient,
        request: variables,
        transaction: context,
      });
    },
    onSuccess: (data, variables, transaction) => {
      applyQueuedMessageSendResult({
        queryClient,
        request: variables,
        result: data,
        transaction,
      });
    },
  });
}

export function useDeleteThreadQueuedMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to delete queued message.",
      showErrorToast: false,
    },
    mutationFn: deleteThreadQueuedMessageOrConfirmMissing,
    onMutate: async (variables): Promise<RemoveQueuedMessageTransaction> =>
      beginRemoveQueuedMessageTransaction({
        queryClient,
        request: variables,
      }),
    onError: (_error, variables, context) => {
      rollbackRemoveQueuedMessageTransaction({
        queryClient,
        request: variables,
        transaction: context,
      });
    },
    onSuccess: (_data, variables) => {
      applyQueuedMessageDeleteResult({
        queryClient,
        threadId: variables.id,
      });
    },
  });
}

export function useStopThread() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to stop thread.",
      lifecycleOperation: "stop_thread",
    },
    mutationFn: async (threadId: string) => {
      await sdk.threads.stop({ threadId });
    },
    onMutate: async (threadId): Promise<StopThreadTransaction> =>
      beginStopThreadTransaction({
        queryClient,
        requestedAt: Date.now(),
        threadId,
      }),
    onError: (_error, threadId, context) => {
      rollbackStopThreadTransaction({
        queryClient,
        threadId,
        transaction: context,
      });
    },
    onSettled: (_data, _error, threadId) => {
      settleStopThreadTransaction({ queryClient, threadId });
    },
  });
}

export function useCancelThreadPlan() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { errorMessage: "Failed to exit Plan mode." },
    mutationFn: async (threadId: string) => {
      await sdk.threads.cancelPlan({ threadId });
    },
    onSuccess: (_data, threadId) => {
      applyThreadPlanCancellationResult({ queryClient, threadId });
      invalidateThreadBannerQueries({ queryClient, threadId });
    },
  });
}

