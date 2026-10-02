import { useEffect, useRef } from "react";
import type { Thread } from "@bb/domain";
import { isThreadRead, type ThreadReadState } from "@bb/client-core";
import {
  isDocumentVisible,
  useDocumentVisibilityRevision,
} from "@/lib/document-visibility";

interface ReadTrackingSnapshot {
  isVisible: boolean;
  isRead: boolean;
  latestAttentionAt: number | null;
  threadId: string;
}

export function useThreadReadTracking({
  markThreadRead,
  thread,
}: {
  markThreadRead: {
    mutateAsync: (input: {
      signal?: AbortSignal;
      threadId: string;
    }) => Promise<ThreadReadState>;
  };
  thread?: ThreadReadState & Pick<Thread, "id">;
}) {
  const previousRef = useRef<ReadTrackingSnapshot | null>(null);
  const manualUnreadMarkerRef = useRef<string | null>(null);
  const pendingReadRef = useRef<AbortController | null>(null);
  const visibilityRevision = useDocumentVisibilityRevision();
  const isVisible = isDocumentVisible();

  useEffect(
    () => () => {
      pendingReadRef.current?.abort();
      previousRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const last = previousRef.current;
    const previous = last?.threadId === thread?.id ? last : null;
    if (previous === null) pendingReadRef.current?.abort();
    const isRead = thread !== undefined && isThreadRead(thread);
    previousRef.current = thread
      ? {
          isVisible,
          isRead,
          latestAttentionAt: thread.latestAttentionAt,
          threadId: thread.id,
        }
      : null;
    if (!isVisible || !thread) return;

    const marker = `${thread.id}:${thread.latestAttentionAt}`;
    const isOpenedOrHasNewAttention =
      previous === null ||
      previous.latestAttentionAt !== thread.latestAttentionAt;
    if (isOpenedOrHasNewAttention) manualUnreadMarkerRef.current = null;
    else if (!isRead && previous?.isVisible && previous.isRead) {
      manualUnreadMarkerRef.current = marker;
    }
    if (isRead) {
      if (manualUnreadMarkerRef.current === marker) {
        manualUnreadMarkerRef.current = null;
      }
      return;
    }
    if (
      isOpenedOrHasNewAttention ||
      (previous?.isVisible === false &&
        manualUnreadMarkerRef.current !== marker)
    ) {
      const controller = new AbortController();
      pendingReadRef.current = controller;
      void markThreadRead
        .mutateAsync({ signal: controller.signal, threadId: thread.id })
        .catch(() => {});
    }
  }, [isVisible, markThreadRead, thread, visibilityRevision]);
}
