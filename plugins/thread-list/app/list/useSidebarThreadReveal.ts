import { useEffect, useMemo, useRef } from "react";
import { useSetAtom } from "jotai";
import { buildSectionKey, CHRONOLOGICAL_CONTAINER_ID } from "@bb/client-core";
import { useBbContext } from "@bb/plugin/app";
import { collectEffectivePinnedThreadIds } from "../model/thread-tree.js";
import { useSidebarData } from "../model/use-sidebar-data.js";
import {
  collapsedSidebarSectionIdsAtom,
  collapsedThreadIdsAtom,
  sidebarCollapsedThreadSectionsAtom,
  usePreferencesReady,
} from "../preferences.js";

function removeCollapsedIds<T extends string>(
  current: T[],
  idsToRemove: ReadonlySet<string>,
): T[] {
  const next = current.filter((id) => !idsToRemove.has(id));
  return next.length === current.length ? current : next;
}

export function useSidebarThreadReveal(): void {
  const selectedThreadId = useBbContext().threadId ?? undefined;
  const { status, threads } = useSidebarData();
  const threadsReady = status === "ready";
  const preferencesReady = usePreferencesReady();
  const setCollapsedThreadIdList = useSetAtom(collapsedThreadIdsAtom);
  const setCollapsedSectionList = useSetAtom(
    sidebarCollapsedThreadSectionsAtom,
  );
  const setCollapsedSidebarSectionIdList = useSetAtom(
    collapsedSidebarSectionIdsAtom,
  );
  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads],
  );
  const effectivePinnedThreadIds = useMemo(
    () => collectEffectivePinnedThreadIds(threads),
    [threads],
  );
  const previousThreadId = useRef<string | undefined>(undefined);
  const pendingNavigation = useRef<string | undefined>(undefined);
  const previousUnreadIds = useRef<ReadonlySet<string> | null>(null);

  useEffect(() => {
    if (previousThreadId.current !== selectedThreadId) {
      previousThreadId.current = selectedThreadId;
      pendingNavigation.current = selectedThreadId;
    }
    if (!preferencesReady || !threadsReady) {
      return;
    }
    const revealIds = new Set<string>();
    if (
      pendingNavigation.current &&
      threadById.has(pendingNavigation.current)
    ) {
      revealIds.add(pendingNavigation.current);
      pendingNavigation.current = undefined;
    }
    const unreadIds = new Set<string>();
    for (const thread of threads) {
      if (thread.isHidden || !thread.isUnread) {
        continue;
      }
      unreadIds.add(thread.id);
      if (
        previousUnreadIds.current &&
        !previousUnreadIds.current.has(thread.id) &&
        thread.id !== selectedThreadId
      ) {
        revealIds.add(thread.id);
      }
    }
    previousUnreadIds.current = unreadIds;
    for (const threadId of revealIds) {
      const thread = threadById.get(threadId);
      if (!thread || thread.isHidden) {
        continue;
      }
      const threadIdsToExpand = new Set<string>();
      let parent =
        thread.parentThreadId === null
          ? undefined
          : threadById.get(thread.parentThreadId);
      while (parent && !threadIdsToExpand.has(parent.id)) {
        threadIdsToExpand.add(parent.id);
        parent =
          parent.parentThreadId === null
            ? undefined
            : threadById.get(parent.parentThreadId);
      }
      setCollapsedThreadIdList((current) =>
        removeCollapsedIds(current, threadIdsToExpand),
      );
      if (effectivePinnedThreadIds.has(thread.id)) {
        setCollapsedSidebarSectionIdList((current) =>
          removeCollapsedIds(current, new Set(["pinned"])),
        );
      } else if (thread.sectionId) {
        const sectionKey = buildSectionKey(
          CHRONOLOGICAL_CONTAINER_ID,
          thread.sectionId,
        );
        setCollapsedSectionList((current) =>
          removeCollapsedIds(current, new Set([sectionKey])),
        );
      } else {
        setCollapsedSidebarSectionIdList((current) =>
          removeCollapsedIds(current, new Set(["threads"])),
        );
      }
    }
  }, [
    selectedThreadId,
    threadsReady,
    preferencesReady,
    threads,
    threadById,
    effectivePinnedThreadIds,
    setCollapsedThreadIdList,
    setCollapsedSectionList,
    setCollapsedSidebarSectionIdList,
  ]);
}
