import { callOp, interactions, threads } from "@bb/plugin/app";
import { prependOlderTimelineRows, type FilePreview } from "@bb/client-core";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type NotifyOnChangeProps,
  type QueryClient,
} from "@tanstack/react-query";
import type { PendingInteraction, ThreadListEntry } from "@bb/domain";
import {
  applyTimelineDelta,
  type ThreadResponse,
  type ThreadTimelineResponse,
  type ThreadWithIncludesResponse,
} from "@bb/server-contract";
import { COMPACT_VIEWPORT_QUERY } from "@bb/shared-ui/hooks/use-compact-viewport";
import { getMediaQuerySnapshot } from "@bb/shared-ui/hooks/use-media-query";
import { loadFilePreview } from "../../lib/api";
import { buildThreadHostFileContentUrl } from "../../lib/file-content-urls";
import { useThreadDetailRealtimeSubscription } from "../useRealtimeSubscription";
import { useDebouncedValue } from "../useDebouncedValue";
import { qk } from "./query-keys";
import { useSidebarNavigation } from "./sidebar-navigation-query";
import { cachedThreads, listSidebarNavigationThreads } from "./thread-cache";

interface QueryOptions {
  enabled?: boolean;
  refetchOnMount?: boolean | "always";
}

interface ThreadSubsetFilters {
  hasParent?: boolean;
  originKind?: ThreadListEntry["originKind"];
  parentThreadId?: string;
  projectId?: string;
  sourceThreadId?: string;
}

interface TurnDetailsIdentity {
  sourceSeqEnd: number;
  sourceSeqStart: number;
  threadId: string;
  turnId: string;
}

const ARCHIVED_PAGE_SIZE = 50;
const THREAD_DETAIL_STALE_TIME_MS = 5_000;
const MENTION_CANDIDATE_LIMIT = 200;
const HEAVY_GC_TIME_MS = 60_000;

function useSidebarThreads(enabled: boolean, filters: ThreadSubsetFilters) {
  const navigation = useSidebarNavigation();
  const pending = enabled && navigation.data === undefined;
  const { hasParent, originKind, parentThreadId, projectId, sourceThreadId } =
    filters;
  const data =
    !enabled || navigation.data === undefined
      ? undefined
      : listSidebarNavigationThreads(navigation.data).filter(
          (thread) =>
            thread.archivedAt === null &&
            thread.visibility !== "hidden" &&
            (projectId === undefined || thread.projectId === projectId) &&
            (parentThreadId === undefined ||
              thread.parentThreadId === parentThreadId) &&
            (sourceThreadId === undefined ||
              thread.sourceThreadId === sourceThreadId) &&
            (originKind === undefined || thread.originKind === originKind) &&
            (hasParent === undefined ||
              (thread.parentThreadId !== null) === hasParent),
        );
  return {
    data,
    isError: pending && navigation.isError,
    isFetching: pending && navigation.isFetching,
    isLoading: pending && navigation.isFetching,
    retry: () => void navigation.refetch(),
  };
}

export function useThreads(
  filters: ThreadSubsetFilters & { archived: false },
  options?: QueryOptions,
) {
  return useSidebarThreads(options?.enabled ?? true, filters);
}

export function useChildThreads(args: {
  enabled: boolean;
  parentThreadId: string | undefined;
}) {
  const { parentThreadId } = args;
  const enabled = args.enabled && Boolean(parentThreadId);
  return useSidebarThreads(enabled, { parentThreadId });
}

export function useProjectThreadSubset(args: {
  enabled?: boolean;
  filters: Pick<ThreadSubsetFilters, "hasParent" | "parentThreadId">;
  projectId: string | undefined;
}) {
  const { filters, projectId } = args;
  const enabled = (args.enabled ?? true) && Boolean(projectId);
  return useSidebarThreads(enabled, { ...filters, projectId });
}

export function useThreadMentionCandidates(args: { enabled?: boolean }) {
  const threads = useSidebarThreads(args.enabled ?? true, {});
  return { ...threads, data: threads.data?.slice(0, MENTION_CANDIDATE_LIMIT) };
}

export function useArchivedThreads(options?: QueryOptions) {
  return useInfiniteQuery({
    queryKey: qk.archivedThreads(),
    queryFn: ({ pageParam, signal }) =>
      callOp(
        threads.list,
        { archived: true, limit: ARCHIVED_PAGE_SIZE, offset: pageParam },
        { signal },
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length < ARCHIVED_PAGE_SIZE ? undefined : pages.flat().length,
    enabled: options?.enabled ?? true,
    staleTime: 10_000,
  });
}

export function hasThreadSearchableQuery(value: string): boolean {
  return value.replace(/\s/g, "").length >= 2;
}

export function useThreadSearch(args: {
  active: boolean;
  limitPerGroup?: number;
  query: string;
}) {
  const { active, limitPerGroup = 20 } = args;
  const query = args.query.trim();
  const debouncedQuery = useDebouncedValue(args.query, 150).trim();
  const searchable = active && hasThreadSearchableQuery(query);
  const hasSearchableQuery = hasThreadSearchableQuery(debouncedQuery);
  const search = useQuery({
    queryKey: qk.threadSearch({ limitPerGroup, query: debouncedQuery }),
    queryFn: ({ signal }) =>
      callOp(
        threads.search,
        { limitPerGroup, query: debouncedQuery },
        { signal },
      ),
    enabled: searchable && hasSearchableQuery,
    staleTime: 10_000,
  });
  return {
    data: search.data,
    debouncedQuery,
    hasSearchableQuery,
    isDebouncing: searchable && query !== debouncedQuery,
    isError: search.isError,
    isFetching: search.isFetching,
    isLoading: search.isLoading,
  };
}

export function useThread(id: string, options?: QueryOptions) {
  const client = useQueryClient();
  const enabled = (options?.enabled ?? true) && Boolean(id);
  useThreadDetailRealtimeSubscription(id, { enabled });
  return useQuery<ThreadResponse>({
    queryKey: qk.threadDetail(id),
    queryFn: ({ signal }) => callOp(threads.get, { threadId: id }, { signal }),
    enabled,
    staleTime: THREAD_DETAIL_STALE_TIME_MS,
    refetchOnMount: options?.refetchOnMount ?? true,
    placeholderData: () => {
      const entry = cachedThreads(client).find((thread) => thread.id === id);
      return (
        entry && {
          ...entry,
          activeBackgroundAgentCount: entry.activity.activeBackgroundAgentCount,
          canRestoreEnvironment: false,
          canSpawnChild: false,
          queuedMessageCount: 0,
        }
      );
    },
  });
}

export function didThreadDetailBootstrapRefreshAfterMount(query: {
  dataUpdatedAt: number;
  isFetchedAfterMount: boolean;
  isSuccess: boolean;
}): boolean {
  const age = Date.now() - query.dataUpdatedAt;
  return (
    query.isSuccess &&
    (query.isFetchedAfterMount ||
      (query.dataUpdatedAt > 0 && age <= THREAD_DETAIL_STALE_TIME_MS))
  );
}

const COMPACT_THREAD_TIMELINE_SEGMENT_LIMIT = 8;

async function fetchTimeline(
  client: QueryClient,
  threadId: string,
  signal: AbortSignal,
): Promise<ThreadTimelineResponse> {
  const previous = client.getQueryData<ThreadTimelineResponse>(
    qk.timeline(threadId),
  );
  const page = {
    threadId,
    ...(getMediaQuerySnapshot(COMPACT_VIEWPORT_QUERY)
      ? { segmentLimit: COMPACT_THREAD_TIMELINE_SEGMENT_LIMIT }
      : {}),
  };
  const aborting = { signal };
  if (previous === undefined) return callOp(threads.timeline, page, aborting);
  const afterSequence = previous.maxSeq;
  const delta = { ...page, afterSequence };
  const response = await callOp(threads.timeline, delta, aborting);
  if (response.delta === undefined) return response;
  const rows = applyTimelineDelta(previous.rows, response.delta);
  return rows === null
    ? callOp(threads.timeline, page, aborting)
    : { ...response, rows, delta: undefined };
}

export function useThreadDetailBootstrap(
  id: string,
  options?: { enabled?: boolean; timelinePrefetch?: boolean },
) {
  const client = useQueryClient();
  const enabled = (options?.enabled ?? true) && Boolean(id);
  useThreadDetailRealtimeSubscription(id, { enabled });
  return useQuery<ThreadWithIncludesResponse>({
    queryKey: qk.threadBootstrap(id),
    queryFn: async ({ signal }) => {
      if (options?.timelinePrefetch) {
        void client.prefetchQuery({
          queryKey: qk.timeline(id),
          queryFn: (context) => fetchTimeline(client, id, context.signal),
        });
      }
      const args = { include: "environment,host", threadId: id };
      const thread: ThreadWithIncludesResponse = await callOp(
        threads.get,
        args,
        { signal },
      );
      const { environment, host: _host, ...detail } = thread;
      client.setQueryData(qk.threadDetail(id), detail);
      if (environment) {
        client.setQueryData(qk.environmentRecord(environment.id), environment);
      }
      return thread;
    },
    enabled,
    staleTime: Infinity,
  });
}

export function useThreadTimeline(
  id: string,
  options?: QueryOptions & { notifyOnChangeProps?: NotifyOnChangeProps },
) {
  const client = useQueryClient();
  const enabled = (options?.enabled ?? true) && Boolean(id);
  useThreadDetailRealtimeSubscription(id, { enabled });
  return useQuery<ThreadTimelineResponse>({
    queryKey: qk.timeline(id),
    queryFn: ({ signal }) => fetchTimeline(client, id, signal),
    enabled,
    notifyOnChangeProps: options?.notifyOnChangeProps,
    refetchOnMount: options?.refetchOnMount ?? true,
  });
}

export function useThreadTimelineTurnSummaryDetails(
  identity: TurnDetailsIdentity,
  options?: QueryOptions,
) {
  const { threadId, turnId, ...range } = identity;
  const turn = { turnId, ...range };
  return useQuery({
    queryKey: qk.turnDetails(threadId, turn),
    queryFn: async ({ signal }) => {
      const input = {
        threadId,
        turnId,
        sourceSeqEnd: identity.sourceSeqEnd,
        sourceSeqStart: identity.sourceSeqStart,
      };
      const details = threads.timelineTurnSummaryDetails;
      const response = await callOp(details, input, { signal });
      let { olderCursor: beforeCursor, rows } = response;
      while (beforeCursor) {
        const page = { ...input, beforeCursor };
        const older = await callOp(details, page, { signal });
        rows = prependOlderTimelineRows({
          olderRows: older.rows,
          loadedRows: rows,
        });
        beforeCursor = older.olderCursor;
      }
      return { ...response, rows, olderCursor: null };
    },
    enabled: (options?.enabled ?? true) && Boolean(threadId && turnId),
    refetchOnMount: options?.refetchOnMount ?? true,
    staleTime: Infinity,
    gcTime: HEAVY_GC_TIME_MS,
  });
}

export function useThreadQueuedMessages(id: string, options?: QueryOptions) {
  const enabled = (options?.enabled ?? true) && Boolean(id);
  useThreadDetailRealtimeSubscription(id, { enabled });
  return useQuery({
    queryKey: qk.queue(id),
    queryFn: ({ signal }) =>
      callOp(threads.listQueuedMessages, { threadId: id }, { signal }),
    enabled,
  });
}

export function useThreadPromptHistory(id: string) {
  return useQuery({
    queryKey: qk.threadPromptHistory(id),
    queryFn: ({ signal }) =>
      callOp(threads.promptHistory, { threadId: id }, { signal }),
    enabled: Boolean(id),
    staleTime: 10_000,
  });
}

export function useThreadPendingInteractions(
  id: string,
  options?: QueryOptions,
) {
  const enabled = (options?.enabled ?? true) && Boolean(id);
  useThreadDetailRealtimeSubscription(id, { enabled });
  return useQuery({
    queryKey: qk.interactions(id),
    queryFn: ({ signal }) =>
      callOp(interactions.list, { threadId: id }, { signal }),
    enabled,
    refetchOnMount: (query) =>
      query.getObserversCount() === 1 ? "always" : true,
  });
}

export function getLatestPendingInteraction(
  interactions: readonly PendingInteraction[] | undefined,
): PendingInteraction | null {
  return (interactions ?? []).reduce<PendingInteraction | null>(
    (latest, interaction) =>
      latest === null || interaction.createdAt > latest.createdAt
        ? interaction
        : latest,
    null,
  );
}

export function isPendingInteractionStateUnknown(
  interactions: readonly PendingInteraction[] | undefined,
  isFetching: boolean,
): boolean {
  return isFetching && !interactions?.length;
}

export function useThreadHostFilePreview(
  id: string,
  environmentId: string | null | undefined,
  path: string | null,
  options?: QueryOptions,
) {
  return useQuery<FilePreview>({
    queryKey: qk.threadHostFile(id, environmentId, path),
    queryFn: ({ signal }) => {
      const url = buildThreadHostFileContentUrl(id, path ?? "");
      const name = path?.split("/").at(-1);
      return loadFilePreview({ name, path: path ?? "", url }, signal);
    },
    enabled: (options?.enabled ?? true) && Boolean(id && environmentId && path),
    refetchOnWindowFocus: true,
    gcTime: HEAVY_GC_TIME_MS,
  });
}
