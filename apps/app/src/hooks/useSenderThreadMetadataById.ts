import { useContext, useEffect, useState } from "react";
import {
  matchQuery,
  notifyManager,
  QueryClientContext,
  type QueryCacheNotifyEvent,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  ThreadOriginKind,
  ThreadVisibility,
  ThreadWithRuntime,
} from "@bb/domain";
import { qk } from "@/hooks/queries/query-keys";
import { ANY, filterFor } from "@/hooks/queries/refresh";
import { cachedThreads } from "@/hooks/queries/thread-cache";

const THREAD_DETAILS = filterFor(qk.threadDetail(ANY));
const THREAD_SOURCES = [
  THREAD_DETAILS,
  filterFor(qk.sidebar()),
  filterFor(qk.archivedThreads()),
];

export interface SenderThreadMetadata {
  projectId: string;
  title: string | null;
  originKind: ThreadOriginKind | null;
  originPluginId: string | null;
  visibility: ThreadVisibility | null;
}

interface SenderThreadTitleSource {
  title: string | null;
  titleFallback: string | null;
}

interface SenderThreadMetadataSource extends SenderThreadTitleSource {
  id: string;
  projectId: string;
  originKind: ThreadOriginKind | null;
  originPluginId: string | null;
  visibility: ThreadVisibility;
}

function senderThreadTitle(source: SenderThreadTitleSource): string | null {
  const title = source.title?.trim();
  if (title) {
    return title;
  }
  const titleFallback = source.titleFallback?.trim();
  return titleFallback || null;
}

function addSenderThreadMetadata(
  metadataById: Map<string, SenderThreadMetadata>,
  thread: SenderThreadMetadataSource,
): void {
  const title = senderThreadTitle(thread);
  const existing = metadataById.get(thread.id);
  if (existing && (existing.title !== null || title === null)) {
    return;
  }
  metadataById.set(thread.id, {
    projectId: thread.projectId,
    title,
    originKind: thread.originKind,
    originPluginId: thread.originPluginId,
    visibility: thread.visibility,
  });
}

function buildSenderThreadMetadataById(
  queryClient: QueryClient | null,
): ReadonlyMap<string, SenderThreadMetadata> {
  const metadataById = new Map<string, SenderThreadMetadata>();
  if (queryClient === null) {
    return metadataById;
  }

  for (const thread of cachedThreads(queryClient)) {
    addSenderThreadMetadata(metadataById, thread);
  }

  const details = queryClient.getQueriesData<ThreadWithRuntime>(THREAD_DETAILS);
  for (const [, thread] of details) {
    if (thread) addSenderThreadMetadata(metadataById, thread);
  }

  return metadataById;
}

function shouldSyncSenderThreadMetadata(event: QueryCacheNotifyEvent): boolean {
  return (
    event.type === "updated" &&
    THREAD_SOURCES.some((filter) => matchQuery(filter, event.query))
  );
}

function areSenderThreadMetadataEntriesEqual(
  left: SenderThreadMetadata,
  right: SenderThreadMetadata,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.title === right.title &&
    left.originKind === right.originKind &&
    left.originPluginId === right.originPluginId &&
    left.visibility === right.visibility
  );
}

function areSenderThreadMetadataMapsEqual(
  left: ReadonlyMap<string, SenderThreadMetadata>,
  right: ReadonlyMap<string, SenderThreadMetadata>,
): boolean {
  if (left === right) {
    return true;
  }
  if (left.size !== right.size) {
    return false;
  }
  for (const [threadId, entry] of left) {
    const other = right.get(threadId);
    if (other === undefined) {
      return false;
    }
    if (!areSenderThreadMetadataEntriesEqual(entry, other)) {
      return false;
    }
  }
  return true;
}

export function useSenderThreadMetadataById(): ReadonlyMap<
  string,
  SenderThreadMetadata
> {
  const queryClient = useContext(QueryClientContext) ?? null;
  const [metadataById, setMetadataById] = useState(() =>
    buildSenderThreadMetadataById(queryClient),
  );

  useEffect(() => {
    if (queryClient === null) {
      return;
    }

    let subscribed = true;
    const syncMetadataById = () => {
      if (subscribed) {
        setMetadataById((current) => {
          const next = buildSenderThreadMetadataById(queryClient);
          return areSenderThreadMetadataMapsEqual(current, next)
            ? current
            : next;
        });
      }
    };
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (shouldSyncSenderThreadMetadata(event)) {
        notifyManager.schedule(syncMetadataById);
      }
    });

    return () => {
      subscribed = false;
      unsubscribe();
    };
  }, [queryClient]);

  return metadataById;
}
