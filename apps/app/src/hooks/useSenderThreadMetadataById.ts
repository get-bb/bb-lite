import { useEffect, useState } from "react";
import {
  notifyManager,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { ThreadWithRuntime } from "@bb/domain";
import {
  allThreadQueryKeyPrefix,
  SIDEBAR_NAVIGATION_QUERY_KEY,
  THREAD_QUERY_KEY,
  THREADS_QUERY_KEY,
  threadsQueryKey,
} from "@/hooks/queries/query-keys";
import { getCachedSidebarNavigationThreads } from "@/hooks/cache-owners/query-cache";
import {
  getCachedThreadLists,
  iterateThreadListCacheEntries,
} from "@/hooks/cache-owners/thread-list-cache-data";

export interface SenderThreadMetadata {
  projectId: string;
  title: string | null;
}

type SenderThreads = ReadonlyMap<string, SenderThreadMetadata>;

const SOURCE_QUERY_KEYS: readonly unknown[] = [
  SIDEBAR_NAVIGATION_QUERY_KEY,
  THREADS_QUERY_KEY,
  THREAD_QUERY_KEY,
];

function readSenderThreads(queryClient: QueryClient): SenderThreads {
  const senders = new Map<string, SenderThreadMetadata>();
  const add = (thread: {
    id: string;
    projectId: string;
    title: string | null;
    titleFallback: string | null;
  }) => {
    const title = thread.title?.trim() || thread.titleFallback?.trim() || null;
    if ((senders.get(thread.id)?.title ?? null) === null) {
      senders.set(thread.id, { projectId: thread.projectId, title });
    }
  };
  getCachedSidebarNavigationThreads(queryClient).forEach(add);
  for (const [, thread] of queryClient.getQueriesData<ThreadWithRuntime>({
    queryKey: allThreadQueryKeyPrefix(),
  })) {
    if (thread) add(thread);
  }
  for (const list of getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  })) {
    for (const thread of iterateThreadListCacheEntries(list.data)) add(thread);
  }
  return senders;
}

export function useSenderThreadMetadataById(): SenderThreads {
  const queryClient = useQueryClient();
  const [senders, setSenders] = useState(() => readSenderThreads(queryClient));
  useEffect(() => {
    const sync = () =>
      setSenders((current) => {
        const next = readSenderThreads(queryClient);
        return JSON.stringify([...current]) === JSON.stringify([...next])
          ? current
          : next;
      });
    return queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        SOURCE_QUERY_KEYS.includes(event.query.queryKey[0])
      ) {
        notifyManager.schedule(sync);
      }
    });
  }, [queryClient]);
  return senders;
}
