import { useEffect, useRef, useState } from "react";
import type { ThreadTimelineUnreadDividerPlacement } from "@/components/thread/timeline";

interface ThreadUnreadDividerState {
  autoScroll: boolean;
  placement: ThreadTimelineUnreadDividerPlacement | null;
}

interface ThreadUnreadDividerSnapshot extends ThreadUnreadDividerState {
  attentionAt: number;
  threadId: string;
}

const NO_UNREAD_DIVIDER_STATE: ThreadUnreadDividerState = {
  autoScroll: false,
  placement: null,
};

export function useThreadUnreadDividerState({
  routeThreadId,
  thread,
}: {
  routeThreadId: string | undefined;
  thread:
    | { id: string; lastReadAt: number | null; latestAttentionAt: number }
    | undefined;
}): ThreadUnreadDividerState {
  const [snapshot, setSnapshot] = useState<ThreadUnreadDividerSnapshot | null>(
    null,
  );
  const trackedThreadIdRef = useRef<string | null>(null);
  const threadId = routeThreadId === thread?.id ? thread?.id : undefined;
  const lastReadAt = thread?.lastReadAt;
  const attentionAt = thread?.latestAttentionAt;
  const isUnread =
    lastReadAt !== undefined &&
    attentionAt !== undefined &&
    (lastReadAt === null || lastReadAt < attentionAt);

  useEffect(() => {
    if (
      threadId === undefined ||
      lastReadAt === undefined ||
      attentionAt === undefined
    ) {
      trackedThreadIdRef.current = null;
      setSnapshot(null);
      return;
    }
    const isFirstTrackedState = trackedThreadIdRef.current !== threadId;
    trackedThreadIdRef.current = threadId;
    setSnapshot((current) => {
      const isCurrent =
        current?.threadId === threadId && current.attentionAt === attentionAt;
      if (isCurrent && lastReadAt !== null) {
        return current;
      }
      const placement: ThreadTimelineUnreadDividerPlacement | null =
        lastReadAt === null
          ? { kind: "before-first" }
          : lastReadAt < attentionAt
            ? { kind: "after-cutoff", cutoffAt: lastReadAt }
            : null;
      return {
        attentionAt,
        autoScroll: isCurrent
          ? current.placement !== null && current.autoScroll
          : isFirstTrackedState && placement !== null,
        placement,
        threadId,
      };
    });
  }, [threadId, lastReadAt, attentionAt]);

  if (
    threadId === undefined ||
    snapshot === null ||
    snapshot.threadId !== threadId ||
    (snapshot.attentionAt !== attentionAt && !isUnread)
  ) {
    return NO_UNREAD_DIVIDER_STATE;
  }
  return {
    autoScroll: snapshot.autoScroll && snapshot.placement !== null,
    placement: snapshot.placement,
  };
}
