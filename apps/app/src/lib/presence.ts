import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { User, UserPresence } from "@bb/domain";
import { useCurrentUser, useUserDirectory } from "@/hooks/queries/user-queries";
import { wsManager } from "./ws";

const NO_PRESENCE: readonly UserPresence[] = [];
const NO_VIEWERS: readonly string[] = [];
let presence: readonly UserPresence[] = NO_PRESENCE;
let viewersByThread = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();
const viewed = new Map<string, number>();

function groupByThread(users: readonly UserPresence[]) {
  const grouped = new Map<string, readonly string[]>();
  for (const { userId, threadIds } of users) {
    for (const threadId of threadIds) {
      const before = grouped.get(threadId) ?? NO_VIEWERS;
      grouped.set(threadId, [...before, userId]);
    }
  }
  for (const [threadId, userIds] of grouped) {
    const previous = viewersByThread.get(threadId);
    if (previous?.join() === userIds.join()) grouped.set(threadId, previous);
  }
  return grouped;
}

wsManager.onPresence((users) => {
  presence = users;
  viewersByThread = groupByThread(users);
  for (const listener of listeners) listener();
});

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function reportViewed() {
  wsManager.setViewedThreads([...viewed.keys()]);
}

export function usePresence(): readonly UserPresence[] {
  return useSyncExternalStore(subscribe, () => presence);
}

export function useThreadViewerIds(threadId: string): readonly string[] {
  return useSyncExternalStore(
    subscribe,
    () => viewersByThread.get(threadId) ?? NO_VIEWERS,
  );
}

export function useOnlineUsers(): User[] {
  const online = usePresence();
  const directory = useUserDirectory();
  return useMemo(
    () => online.flatMap((entry) => directory.get(entry.userId) ?? []),
    [online, directory],
  );
}

export function useThreadViewers(threadId: string | null | undefined): User[] {
  const online = usePresence();
  const directory = useUserDirectory();
  const self = useCurrentUser()?.id;
  return useMemo(() => {
    if (!threadId) return [];
    return online
      .filter((entry) => entry.userId !== self)
      .filter((entry) => entry.threadIds.includes(threadId))
      .flatMap((entry) => directory.get(entry.userId) ?? []);
  }, [online, directory, self, threadId]);
}

export function useReportViewedThread(
  threadId: string | null | undefined,
): void {
  useEffect(() => {
    if (!threadId) return;
    viewed.set(threadId, (viewed.get(threadId) ?? 0) + 1);
    reportViewed();
    return () => {
      const count = (viewed.get(threadId) ?? 1) - 1;
      if (count <= 0) viewed.delete(threadId);
      else viewed.set(threadId, count);
      reportViewed();
    };
  }, [threadId]);
}
