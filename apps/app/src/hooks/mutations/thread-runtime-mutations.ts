import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { nanoid } from "nanoid";
import type {
  Environment,
  ResolvedThreadExecutionOptions,
  ThreadListEntry,
  ThreadQueuedMessage,
} from "@bb/domain";
import type {
  CreateQueuedMessageRequest,
  SendQueuedMessageMode,
  SendQueuedMessageResponse,
  SidebarBootstrapResponse,
  ThreadResponse,
  ThreadTimelineResponse,
  TimelineRow,
  UpdateQueuedMessageRequest,
} from "@bb/server-contract";
import {
  OPTIMISTIC_TIMELINE_ROW_ID_PREFIX,
  type AppCreateThreadRequest,
} from "@bb/client-core";
import { collectPromptAttachments } from "@/lib/prompt-attachments";
import { BbHttpError, sdk } from "@/lib/sdk";
import type { SendThreadMessageMutationRequest } from "./mutation-request-types";
import { qk } from "../queries/query-keys";
import {
  patchCachedThreads,
  refreshThreadCaches,
  restoreCacheSnapshot,
  snapshotThreadCaches,
} from "../queries/thread-cache";

type Queue = ThreadQueuedMessage[];
type SendMode =
  | SendThreadMessageMutationRequest["mode"]
  | SendQueuedMessageMode;

interface QueuedMessageRequest {
  id: string;
  queuedMessageId: string;
}

interface TurnContext {
  previousThread: ThreadResponse | undefined;
  rowId: string;
}

function mapQueue(
  client: QueryClient,
  threadId: string,
  update: (queue: Queue) => Queue,
): void {
  client.setQueryData<Queue>(
    qk.queue(threadId),
    (queue) => queue && update(queue),
  );
}

function removeQueued(client: QueryClient, threadId: string, id: string) {
  mapQueue(client, threadId, (queue) =>
    queue.filter((message) => message.id !== id),
  );
}

function upsertQueued(
  client: QueryClient,
  threadId: string,
  message: ThreadQueuedMessage,
  optimisticId: string | null,
): void {
  client.setQueryData<Queue>(qk.queue(threadId), (queue = []) => {
    const known = queue.some(({ id }) => id === message.id);
    const target = known ? message.id : optimisticId;
    if (!queue.some(({ id }) => id === target)) return [...queue, message];
    return queue.flatMap((current) => {
      if (current.id === target) return [message];
      return current.id === optimisticId ? [] : [current];
    });
  });
}

function insertOptimisticQueued(
  client: QueryClient,
  request: CreateQueuedMessageRequest & { id: string },
): string {
  const defaults = client.getQueryData<ResolvedThreadExecutionOptions | null>(
    qk.threadExecution(request.id),
  );
  const createdAt = Date.now();
  const message: ThreadQueuedMessage = {
    id: `optimistic-queued-${nanoid()}`,
    origin: null,
    originPluginId: null,
    initiator: "user",
    senderThreadId: null,
    threadId: request.id,
    content: request.input,
    model: request.model ?? defaults?.model ?? "pending",
    reasoningLevel:
      request.reasoningLevel ?? defaults?.reasoningLevel ?? "medium",
    permissionMode:
      request.permissionMode ?? defaults?.permissionMode ?? "auto",
    serviceTier: request.serviceTier ?? defaults?.serviceTier ?? "default",
    groupWithNext: false,
    sendAt: null,
    waitingOn: null,
    failureReason: null,
    payload: { kind: "inline" },
    editable: true,
    createdAt,
    updatedAt: createdAt,
  };
  client.setQueryData<Queue>(qk.queue(request.id), (queue = []) => [
    ...queue,
    message,
  ]);
  return message.id;
}

function mapTimelineRows(
  client: QueryClient,
  threadId: string,
  update: (rows: TimelineRow[]) => TimelineRow[],
): void {
  client.setQueryData<ThreadTimelineResponse>(
    qk.timeline(threadId),
    (timeline) => timeline && { ...timeline, rows: update(timeline.rows) },
  );
}

function optimisticUserRow(
  threadId: string,
  input: SendThreadMessageMutationRequest["input"],
  steer: boolean,
): TimelineRow {
  const createdAt = Date.now();
  const attachments = collectPromptAttachments(input);
  return {
    id: `${OPTIMISTIC_TIMELINE_ROW_ID_PREFIX}${nanoid()}`,
    kind: "conversation",
    role: "user",
    threadId,
    turnId: null,
    sourceSeqStart: 0,
    sourceSeqEnd: 0,
    startedAt: createdAt,
    createdAt,
    text: input
      .flatMap((entry) =>
        entry.type === "text" && entry.visibility !== "agent-only"
          ? [entry.text]
          : [],
      )
      .join("\n\n"),
    mentions: [],
    attachments: attachments
      ? {
          webImages: attachments.webImages,
          localImages: attachments.localImages,
          localFiles: attachments.localFiles,
          imageUrls: attachments.imageUrls ?? [],
          localImagePaths: attachments.localImagePaths ?? [],
          localFilePaths: attachments.localFilePaths ?? [],
        }
      : null,
    initiator: "user",
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    turnRequest: {
      isGrouped: false,
      kind: steer ? "steer" : "message",
      status: "pending",
    },
  };
}

async function cancelRuntimeQueries(client: QueryClient, threadId: string) {
  await Promise.all(
    [
      qk.threadDetail(threadId),
      qk.queue(threadId),
      qk.timeline(threadId),
      qk.turnDetails(threadId),
    ].map((queryKey) => client.cancelQueries({ queryKey })),
  );
}

function beginTurn(
  client: QueryClient,
  threadId: string,
  input: SendThreadMessageMutationRequest["input"],
  mode: SendMode,
): TurnContext {
  const detailKey = qk.threadDetail(threadId);
  const previousThread = client.getQueryData<ThreadResponse>(detailKey);
  const steer =
    mode === "steer" ||
    mode === "steer-if-active" ||
    (mode === "auto" && previousThread?.status === "active");
  const row = optimisticUserRow(threadId, input, steer);
  client.setQueryData<ThreadResponse>(
    detailKey,
    (thread) =>
      thread && {
        ...thread,
        status: "active",
        updatedAt: Math.max(thread.updatedAt, row.createdAt),
        runtime: {
          ...thread.runtime,
          displayStatus:
            thread.runtime.displayStatus === "waiting-for-host"
              ? "waiting-for-host"
              : "active",
        },
      },
  );
  mapTimelineRows(client, threadId, (rows) => [...rows, row]);
  return { previousThread, rowId: row.id };
}

function rollbackTurn(
  client: QueryClient,
  threadId: string,
  turn: TurnContext | null | undefined,
): void {
  if (!turn) return;
  mapTimelineRows(client, threadId, (rows) =>
    rows.filter((row) => row.id !== turn.rowId),
  );
  if (turn.previousThread) {
    client.setQueryData(qk.threadDetail(threadId), turn.previousThread);
  }
}

function refreshRuntime(client: QueryClient, threadId: string): void {
  for (const queryKey of [
    qk.threadDetail(threadId),
    qk.queue(threadId),
    qk.timeline(threadId),
    qk.threadPromptHistory(threadId),
    qk.threadExecution(threadId),
  ]) {
    void client.invalidateQueries({ queryKey }, { cancelRefetch: false });
  }
}

function insertCreatedThread(
  client: QueryClient,
  thread: ThreadResponse,
  request: AppCreateThreadRequest,
): void {
  const { environment } = request;
  const environmentHostId =
    environment.type === "reuse"
      ? client.getQueryData<Environment>(
          qk.environment(environment.environmentId),
        )?.hostId
      : environment.type === "provider" &&
          environment.machine?.type === "existing"
        ? environment.machine.hostId
        : null;
  const entry: ThreadListEntry = {
    ...thread,
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 0,
    },
    queuedWork: thread.queuedMessageCount > 0 ? "waiting" : "none",
    pinSortKey: null,
    hasPendingInteraction: false,
    environmentHostId: environmentHostId ?? null,
    environmentName: null,
    environmentBranchName: null,
    environmentPath: null,
    environmentProviderId: null,
    environmentIsWorktree: null,
    environmentWorkspaceDisplayKind: "other",
  };
  type Project = SidebarBootstrapResponse["personalProject"];
  const insert = (project: Project): Project =>
    project.id !== thread.projectId ||
    project.threads.some(({ id }) => id === thread.id)
      ? project
      : { ...project, threads: [entry, ...project.threads] };
  client.setQueryData<SidebarBootstrapResponse>(
    qk.sidebar(),
    (navigation) =>
      navigation && {
        sections: navigation.sections,
        projects: navigation.projects.map(insert),
        personalProject: insert(navigation.personalProject),
      },
  );
}

export function useCreateThread() {
  const client = useQueryClient();
  return useMutation({
    meta: {
      errorMessage: "Failed to create thread.",
      lifecycleOperation: "create_thread",
    },
    mutationFn: (request: AppCreateThreadRequest) =>
      sdk.threads.spawn({
        ...request,
        origin: "app",
        startedOnBehalfOf: request.startedOnBehalfOf ?? null,
      }),
    onSuccess: async (thread, request) => {
      client.setQueryData(qk.threadDetail(thread.id), thread);
      if (thread.visibility !== "hidden") {
        await client.cancelQueries({ queryKey: qk.sidebar() });
        insertCreatedThread(client, thread, request);
      }
      refreshThreadCaches(client, []);
      for (const queryKey of [
        qk.projectPromptHistory(request.projectId),
        qk.projectBranches(request.projectId),
      ]) {
        void client.invalidateQueries({ queryKey });
      }
    },
  });
}

export function useSendThreadMessage() {
  const client = useQueryClient();
  return useMutation({
    meta: {
      errorMessage: "Failed to send message.",
      lifecycleOperation: "send_message",
      showErrorToast: false,
    },
    mutationFn: ({ id, ...request }: SendThreadMessageMutationRequest) =>
      sdk.threads.send({ threadId: id, ...request }),
    onMutate: async (request) => {
      const { id, input, mode } = request;
      await cancelRuntimeQueries(client, id);
      const status = client.getQueryData<ThreadResponse>(
        qk.threadDetail(id),
      )?.status;
      return mode === "queue-if-active" && status === "active"
        ? { queuedId: insertOptimisticQueued(client, request), turn: null }
        : { queuedId: null, turn: beginTurn(client, id, input, mode) };
    },
    onError: (_error, { id }, context) => {
      if (context?.queuedId) removeQueued(client, id, context.queuedId);
      rollbackTurn(client, id, context?.turn);
    },
    onSuccess: (result, { id }, context) => {
      if (result.delivery === "queued") {
        rollbackTurn(client, id, context.turn);
        upsertQueued(client, id, result.queuedMessage, context.queuedId);
      } else if (context.queuedId) {
        removeQueued(client, id, context.queuedId);
      }
    },
    onSettled: (_data, _error, { id }) => refreshRuntime(client, id),
  });
}

export function useCreateThreadQueuedMessage() {
  const client = useQueryClient();
  return useMutation({
    meta: {
      errorMessage: "Failed to queue message.",
      lifecycleOperation: "queue_message",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
      ...request
    }: CreateQueuedMessageRequest & { id: string }) =>
      sdk.threads.queuedMessages.create({ threadId: id, ...request }),
    onMutate: async (request) => {
      await client.cancelQueries({ queryKey: qk.queue(request.id) });
      return insertOptimisticQueued(client, request);
    },
    onError: (_error, { id }, optimisticId) => {
      if (optimisticId) removeQueued(client, id, optimisticId);
    },
    onSuccess: (message, { id }, optimisticId) =>
      upsertQueued(client, id, message, optimisticId),
    onSettled: (_data, _error, { id }) => refreshRuntime(client, id),
  });
}

export function useUpdateThreadQueuedMessage() {
  const client = useQueryClient();
  return useMutation({
    meta: {
      errorMessage: "Failed to update queued message.",
      lifecycleOperation: "update_queued_message",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
      ...request
    }: UpdateQueuedMessageRequest & QueuedMessageRequest) =>
      sdk.threads.queuedMessages.update({ threadId: id, ...request }),
    onMutate: async ({ id, input, queuedMessageId }) => {
      const queryKey = qk.queue(id);
      await client.cancelQueries({ queryKey });
      const previous = client.getQueryData<Queue>(queryKey);
      mapQueue(client, id, (queue) =>
        queue.map((message) =>
          message.id === queuedMessageId
            ? { ...message, content: input }
            : message,
        ),
      );
      return previous;
    },
    onError: (_error, { id }, previous) => {
      client.setQueryData(qk.queue(id), previous);
    },
    onSuccess: (message, { id }) => upsertQueued(client, id, message, null),
    onSettled: (_data, _error, { id }) => refreshRuntime(client, id),
  });
}

export function useSendThreadQueuedMessage() {
  const client = useQueryClient();
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
    }: QueuedMessageRequest & {
      mode: SendQueuedMessageMode;
    }): Promise<SendQueuedMessageResponse> =>
      sdk.threads.queuedMessages.send({ threadId: id, queuedMessageId, mode }),
    onMutate: async ({ id, mode, queuedMessageId }) => {
      await cancelRuntimeQueries(client, id);
      const queue = client.getQueryData<Queue>(qk.queue(id));
      const message = queue?.find(({ id }) => id === queuedMessageId);
      removeQueued(client, id, queuedMessageId);
      const turn = message
        ? beginTurn(client, id, message.content, mode)
        : null;
      return { queue, turn };
    },
    onError: (_error, { id }, context) => {
      client.setQueryData(qk.queue(id), context?.queue);
      rollbackTurn(client, id, context?.turn);
    },
    onSuccess: (result, { id }, context) => {
      if (result.delivery !== "queued") return;
      rollbackTurn(client, id, context.turn);
      client.setQueryData(qk.queue(id), context.queue);
      upsertQueued(client, id, result.queuedMessage, null);
    },
    onSettled: (_data, _error, { id }) => refreshRuntime(client, id),
  });
}

export function useDeleteThreadQueuedMessage() {
  const client = useQueryClient();
  return useMutation({
    meta: {
      errorMessage: "Failed to delete queued message.",
      showErrorToast: false,
    },
    mutationFn: async ({ id, queuedMessageId }: QueuedMessageRequest) => {
      const request = { threadId: id, queuedMessageId };
      await sdk.threads.queuedMessages.delete(request).catch((error) => {
        if (!(error instanceof BbHttpError) || error.status !== 404) {
          throw error;
        }
      });
    },
    onMutate: async ({ id, queuedMessageId }) => {
      const queryKey = qk.queue(id);
      await client.cancelQueries({ queryKey });
      const previous = client.getQueryData<Queue>(queryKey);
      removeQueued(client, id, queuedMessageId);
      return previous;
    },
    onError: (_error, { id }, previous) => {
      client.setQueryData(qk.queue(id), previous);
    },
    onSettled: (_data, _error, { id }) => refreshRuntime(client, id),
  });
}

export function useStopThread() {
  const client = useQueryClient();
  return useMutation({
    meta: {
      errorMessage: "Failed to stop thread.",
      lifecycleOperation: "stop_thread",
    },
    mutationFn: async (threadId: string) => {
      await sdk.threads.stop({ threadId });
    },
    onMutate: async (threadId) => {
      const snapshot = await snapshotThreadCaches(client, [threadId]);
      const requestedAt = Date.now();
      patchCachedThreads(
        client,
        (thread) => ({
          status: "stopping",
          runtime: { ...thread.runtime, displayStatus: "stopping" },
          updatedAt: Math.max(thread.updatedAt, requestedAt),
        }),
        [threadId],
      );
      return snapshot;
    },
    onError: (_error, _threadId, snapshot) =>
      restoreCacheSnapshot(client, snapshot),
    onSettled: (_data, _error, threadId) =>
      refreshThreadCaches(client, [threadId]),
  });
}

export function useCancelThreadPlan() {
  const client = useQueryClient();
  return useMutation({
    meta: { errorMessage: "Failed to exit Plan mode." },
    mutationFn: async (threadId: string) => {
      await sdk.threads.cancelPlan({ threadId });
    },
    onSuccess: (_data, threadId) => {
      refreshRuntime(client, threadId);
      refreshThreadCaches(client, [threadId]);
    },
  });
}
