import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { Thread, ThreadListEntry, ThreadWithRuntime } from "@bb/domain";
import type {
  ThreadArchiveAllResponse,
  ThreadResponse,
  UpdateThreadRequest,
} from "@bb/server-contract";
import { sdk } from "../../lib/sdk";
import type { LifecycleErrorOperation } from "../../lib/lifecycle-errors";
import { qk } from "../queries/query-keys";
import {
  cachedThreads,
  findCachedThread,
  mapCachedThreadLists,
  patchCachedThreads,
  refreshThreadCaches,
  restoreCacheSnapshot,
  snapshotThreadCaches,
  type CacheSnapshot,
  type ThreadPatch,
} from "../queries/thread-cache";

interface ThreadMutationRequest {
  id: string;
}

interface ThreadMetadataUpdate {
  threadId: string;
  parentThreadId?: string | null;
  sectionId?: string | null;
  title?: string | null;
}

interface ThreadReadMutationInput {
  signal?: AbortSignal;
  threadId: string;
}

export class ArchiveThreadConfirmationRequired extends Error {
  constructor(readonly childThreadCount: number) {
    super("Archiving child threads requires confirmation");
  }
}

const UNPINNED = { pinnedAt: null, pinSortKey: null };
const recentlyArchived = new Map<string, ThreadListEntry>();

function metadataPatch(
  client: QueryClient,
  update: ThreadMetadataUpdate,
): ThreadPatch {
  const { threadId, title } = update;
  let { parentThreadId, sectionId } = update;
  const current = findCachedThread(client, threadId)?.parentThreadId;
  if (parentThreadId === null && sectionId === undefined && current) {
    const parent = findCachedThread(client, current);
    if (parent) sectionId = parent.sectionId;
    else parentThreadId = undefined;
  }
  return {
    ...(title !== undefined ? { title } : {}),
    ...(sectionId !== undefined ? { sectionId } : {}),
    ...(parentThreadId !== undefined ? { parentThreadId } : {}),
  };
}

export async function beginThreadUpdates(
  client: QueryClient,
  updates: readonly ThreadMetadataUpdate[],
): Promise<CacheSnapshot> {
  const threadIds = [...new Set(updates.map((update) => update.threadId))];
  const snapshot = await snapshotThreadCaches(client, threadIds);
  const patches = new Map<string, ThreadPatch>();
  for (const update of updates) {
    patches.set(update.threadId, {
      ...patches.get(update.threadId),
      ...metadataPatch(client, update),
    });
  }
  patchCachedThreads(client, (thread) => patches.get(thread.id), threadIds);
  return snapshot;
}

export function settleThreadUpdates(
  client: QueryClient,
  threadIds: readonly string[],
  failedSnapshot?: CacheSnapshot,
): void {
  restoreCacheSnapshot(client, failedSnapshot);
  refreshThreadCaches(client, threadIds);
}

function useThreadPatchMutation<TVariables, TData>(config: {
  errorMessage: string;
  meta?: Record<string, unknown>;
  threadId: (variables: TVariables) => string;
  patch: (variables: TVariables) => (thread: ThreadWithRuntime) => ThreadPatch;
  mutationFn: (variables: TVariables) => Promise<TData>;
}) {
  const client = useQueryClient();
  return useMutation({
    meta: { errorMessage: config.errorMessage, ...config.meta },
    mutationFn: config.mutationFn,
    onMutate: async (variables) => {
      const threadIds = [config.threadId(variables)];
      const snapshot = await snapshotThreadCaches(client, threadIds);
      patchCachedThreads(client, config.patch(variables), threadIds);
      return snapshot;
    },
    onError: (_error, _variables, snapshot) =>
      restoreCacheSnapshot(client, snapshot),
    onSettled: (_data, _error, variables) =>
      refreshThreadCaches(client, [config.threadId(variables)]),
  });
}

export function useUpdateThread(options?: {
  errorMessage?: string | undefined;
  lifecycleOperation?: LifecycleErrorOperation | undefined;
  showErrorToast?: boolean;
}) {
  const client = useQueryClient();
  return useThreadPatchMutation({
    errorMessage: options?.errorMessage ?? "Failed to update thread.",
    meta: {
      showErrorToast: options?.showErrorToast ?? true,
      lifecycleOperation: options?.lifecycleOperation,
    },
    threadId: ({ id }: ThreadMutationRequest & UpdateThreadRequest) => id,
    patch: ({ id, ...update }) => {
      const patch = metadataPatch(client, { threadId: id, ...update });
      return () => patch;
    },
    mutationFn: ({ id, ...request }): Promise<ThreadResponse> =>
      sdk.threads.update({ threadId: id, ...request }),
  });
}

export function usePinThread() {
  return useThreadPatchMutation({
    errorMessage: "Failed to pin thread.",
    threadId: ({ id }: ThreadMutationRequest) => id,
    patch: () => {
      const pinned = { pinnedAt: Date.now(), pinSortKey: null };
      return () => pinned;
    },
    mutationFn: ({ id }) => sdk.threads.pin({ threadId: id }),
  });
}

export function useUnpinThread() {
  return useThreadPatchMutation({
    errorMessage: "Failed to unpin thread.",
    threadId: ({ id }: ThreadMutationRequest) => id,
    patch: () => () => UNPINNED,
    mutationFn: ({ id }) => sdk.threads.unpin({ threadId: id }),
  });
}

export function useMoveThreadToSection() {
  const { mutate: updateThread } = useUpdateThread();
  const { mutate: unpinThread } = useUnpinThread();
  const { mutate: unpinAndMoveThread } = useThreadPatchMutation({
    errorMessage: "Failed to unpin and move thread.",
    threadId: ({ id }: ThreadMutationRequest & { sectionId: string | null }) =>
      id,
    patch:
      ({ sectionId }) =>
      () => ({ ...UNPINNED, sectionId }),
    mutationFn: async ({ id, sectionId }) => {
      await sdk.threads.unpin({ threadId: id });
      return sdk.threads.update({ sectionId, threadId: id });
    },
  });
  return ({
    thread,
    sectionId,
  }: {
    sectionId: string | null;
    thread: Pick<Thread, "id" | "pinnedAt" | "sectionId">;
  }) => {
    const { id } = thread;
    if (thread.pinnedAt === null) {
      if (thread.sectionId !== sectionId) updateThread({ id, sectionId });
    } else if (thread.sectionId === sectionId) unpinThread({ id });
    else unpinAndMoveThread({ id, sectionId });
  };
}

function readStatePatch(read: boolean) {
  return (thread: ThreadWithRuntime): ThreadPatch => ({
    lastReadAt: read ? Math.max(Date.now(), thread.latestAttentionAt) : null,
  });
}

export function useMarkThreadRead() {
  return useThreadPatchMutation({
    errorMessage: "Failed to mark thread read.",
    meta: { showErrorToast: false },
    threadId: ({ threadId }: ThreadReadMutationInput) => threadId,
    patch: () => readStatePatch(true),
    mutationFn: (input) => sdk.threads.markRead(input),
  });
}

export function useMarkThreadUnread() {
  return useThreadPatchMutation({
    errorMessage: "Failed to mark thread unread.",
    meta: { showErrorToast: false },
    threadId: ({ threadId }: ThreadReadMutationInput) => threadId,
    patch: () => readStatePatch(false),
    mutationFn: (input) => sdk.threads.markUnread(input),
  });
}

function setArchivedAt(
  client: QueryClient,
  threadId: string,
  archivedAt: number | null,
): void {
  client.setQueryData<ThreadResponse>(
    qk.threadDetail(threadId),
    (thread) => thread && { ...thread, archivedAt },
  );
}

export function useArchiveThreadAndChildren() {
  const client = useQueryClient();
  return useMutation({
    meta: {
      errorMessage: "Failed to archive thread and children.",
      lifecycleOperation: "archive_thread",
      showErrorToast: false,
    },
    mutationFn: async ({
      id,
      childThreadsConfirmed,
    }: ThreadMutationRequest & {
      childThreadsConfirmed: boolean;
    }): Promise<ThreadArchiveAllResponse> => {
      if (!childThreadsConfirmed) {
        const summary = await sdk.threads.childSummary({ threadId: id });
        if (summary.unarchivedDescendantCount > 0) {
          throw new ArchiveThreadConfirmationRequired(
            summary.unarchivedDescendantCount,
          );
        }
      }
      return sdk.threads.archiveAll({ threadId: id });
    },
    onMutate: async ({ id }) => {
      const family = cachedThreads(client).filter(
        (thread) =>
          thread.archivedAt === null &&
          (thread.id === id || thread.parentThreadId === id),
      );
      const threadIds = [...new Set([id, ...family.map(({ id }) => id)])];
      const snapshot = await snapshotThreadCaches(client, threadIds);
      const archivedAt = Date.now();
      for (const thread of family) recentlyArchived.set(thread.id, thread);
      for (const threadId of threadIds) {
        setArchivedAt(client, threadId, archivedAt);
      }
      mapCachedThreadLists(client, (threads) =>
        threads.filter(
          (thread) =>
            thread.archivedAt !== null || !threadIds.includes(thread.id),
        ),
      );
      return { snapshot, threadIds };
    },
    onError: (_error, _variables, context) =>
      restoreCacheSnapshot(client, context?.snapshot),
    onSettled: (data, _error, _variables, context) =>
      refreshThreadCaches(
        client,
        data?.archivedThreadIds ?? context?.threadIds ?? [],
      ),
  });
}

export function useUnarchiveThread() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ["unarchive-thread"],
    meta: { errorMessage: "Failed to unarchive thread." },
    mutationFn: async ({ id }: ThreadMutationRequest) => {
      await sdk.threads.unarchive({ threadId: id });
    },
    onMutate: async ({ id }) => {
      const snapshot = await snapshotThreadCaches(client, [id]);
      const entry =
        recentlyArchived.get(id) ??
        cachedThreads(client).find((thread) => thread.id === id);
      recentlyArchived.delete(id);
      setArchivedAt(client, id, null);
      mapCachedThreadLists(client, (threads, projectId) => {
        const rest = threads.filter((thread) => thread.id !== id);
        return entry && projectId === entry.projectId
          ? [...rest, { ...entry, archivedAt: null }]
          : rest;
      });
      return snapshot;
    },
    onError: (_error, _variables, snapshot) =>
      restoreCacheSnapshot(client, snapshot),
    onSettled: (_data, _error, { id }) => refreshThreadCaches(client, [id]),
  });
}

export function dropCachedThread(client: QueryClient, threadId: string): void {
  void client.cancelQueries({ queryKey: qk.threadDetail(threadId) });
  client.setQueryData<ThreadResponse>(
    qk.threadDetail(threadId),
    (thread) => thread && { ...thread, deletedAt: Date.now() },
  );
  mapCachedThreadLists(client, (threads) =>
    threads.filter((thread) => thread.id !== threadId),
  );
}

export function useDeleteThread() {
  const client = useQueryClient();
  return useMutation({
    meta: { errorMessage: "Failed to delete thread." },
    mutationFn: async ({
      childThreadsConfirmed,
      id,
    }: ThreadMutationRequest & { childThreadsConfirmed: boolean }) => {
      await sdk.threads.delete({ childThreadsConfirmed, threadId: id });
    },
    onSuccess: (_data, { id }) => {
      dropCachedThread(client, id);
      refreshThreadCaches(client, []);
    },
  });
}
