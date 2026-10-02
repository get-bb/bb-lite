import type { SidebarSectionDefinition } from "@bb/client-core";
import {
  buildPinnedThreadState,
  buildSectionThreadList,
  flattenThreadItems,
  getThreadItemKey,
  threadItemNodes,
  type SidebarThread,
  type ThreadComparator,
  type ThreadItem,
  type ThreadNode,
} from "../model/thread-tree.js";

interface ResolveNestPreviewBeforeKeyArgs {
  activeThread: SidebarThread;
  compareThreads: ThreadComparator;
  draftThreadIds: ReadonlySet<string>;
  groupThreadsByEnvironment: boolean;
  parentThreadId: string;
  pinnedRootNodes: readonly ThreadNode[];
  sections: readonly SidebarSectionDefinition[];
  threads: readonly SidebarThread[];
}

function findThreadNode(
  items: readonly ThreadItem[],
  threadId: string,
): ThreadNode | null {
  for (const node of items.flatMap(threadItemNodes)) {
    if (node.thread.id === threadId) return node;
    const nested = findThreadNode(node.children, threadId);
    if (nested) return nested;
  }
  return null;
}

function beforeKeyAfterThread(
  parentNode: ThreadNode | null,
  threadId: string,
): string | null {
  const siblings = parentNode?.children ?? [];
  const index = siblings.findIndex((item) =>
    threadItemNodes(item).some((node) => node.thread.id === threadId),
  );
  const next = index === -1 ? undefined : siblings[index + 1];
  return next ? getThreadItemKey(next) : null;
}

function withPatchedThread(
  threads: readonly SidebarThread[],
  patched: SidebarThread,
): SidebarThread[] {
  return [...threads.filter((thread) => thread.id !== patched.id), patched];
}

export function resolveSidebarNestPreviewBeforeKey({
  activeThread,
  compareThreads,
  draftThreadIds,
  groupThreadsByEnvironment,
  parentThreadId,
  pinnedRootNodes,
  sections,
  threads,
}: ResolveNestPreviewBeforeKeyArgs): string | null {
  const pinnedItems = pinnedRootNodes.map<ThreadItem>((node) => ({
    kind: "thread",
    node,
  }));
  if (findThreadNode(pinnedItems, parentThreadId)) {
    const projected = buildPinnedThreadState(
      withPatchedThread(flattenThreadItems(pinnedItems), {
        ...activeThread,
        parentThreadId,
        pinnedAt: null,
      }),
      draftThreadIds,
    );
    return beforeKeyAfterThread(
      findThreadNode(
        projected.rootNodes.map((node) => ({ kind: "thread", node })),
        parentThreadId,
      ),
      activeThread.id,
    );
  }
  const projected = buildSectionThreadList(
    withPatchedThread(threads, { ...activeThread, parentThreadId }),
    compareThreads,
    sections,
    draftThreadIds,
    groupThreadsByEnvironment,
  );
  return beforeKeyAfterThread(
    findThreadNode(
      [
        ...projected.sections.flatMap((section) => section.items),
        ...projected.loose,
      ],
      parentThreadId,
    ),
    activeThread.id,
  );
}
