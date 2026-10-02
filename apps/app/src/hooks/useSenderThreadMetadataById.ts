import { useEffect, useState } from "react";
import {
  matchQuery,
  notifyManager,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { ThreadWithRuntime } from "@bb/domain";
import { qk } from "@/hooks/queries/query-keys";
import { ANY, filterFor } from "@/hooks/queries/refresh";
import { cachedThreads } from "@/hooks/queries/thread-cache";

export interface SenderThreadMetadata {
  projectId: string;
  title: string | null;
}

type SenderThreads = ReadonlyMap<string, SenderThreadMetadata>;

const THREAD_DETAILS = filterFor(qk.threadDetail(ANY));
const THREAD_SOURCES = [
  THREAD_DETAILS,
  filterFor(qk.sidebar()),
  filterFor(qk.archivedThreads()),
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
  cachedThreads(queryClient).forEach(add);
  for (const [, thread] of queryClient.getQueriesData<ThreadWithRuntime>(
    THREAD_DETAILS,
  )) {
    if (thread) add(thread);
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
        THREAD_SOURCES.some((filter) => matchQuery(filter, event.query))
      ) {
        notifyManager.schedule(sync);
      }
    });
  }, [queryClient]);
  return senders;
}
