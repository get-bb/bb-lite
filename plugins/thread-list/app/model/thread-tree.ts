import {
  buildSectionKey,
  CHRONOLOGICAL_CONTAINER_ID,
  compareCodepoint,
  type SidebarSectionDefinition,
  type ThreadListIndicatorState,
} from "@bb/client-core";
import type { PluginSidebarThread } from "@bb/plugin/app";
import { rollupThreadActivity } from "./thread-activity.js";

export type SidebarThread = PluginSidebarThread;

export interface ThreadNode {
  thread: SidebarThread;
  children: ThreadNode[];
  depth: number;
  childCount: number;
  childActivity: ThreadListIndicatorState;
}

export interface SectionGroup {
  id: string;
  key: string;
  name: string;
  nodes: ThreadNode[];
  threads: SidebarThread[];
  activity: ThreadListIndicatorState;
}

export interface SectionThreadList {
  sections: SectionGroup[];
  loose: ThreadNode[];
}

interface PinnedThreadState {
  effectivePinnedThreadIds: Set<string>;
  rootNodes: ThreadNode[];
}

type ThreadComparator = (left: SidebarThread, right: SidebarThread) => number;

function compareByCreatedAtDescending(
  left: SidebarThread,
  right: SidebarThread,
): number {
  const createdAtDelta = right.createdAt - left.createdAt;
  return createdAtDelta !== 0
    ? createdAtDelta
    : compareCodepoint(left.id, right.id);
}

function compareStandardThreads(
  left: SidebarThread,
  right: SidebarThread,
): number {
  const leftIsActive = left.status === "active";
  if (leftIsActive !== (right.status === "active")) {
    return leftIsActive ? -1 : 1;
  }
  const latestAttentionAtDelta =
    right.latestAttentionAt - left.latestAttentionAt;
  return leftIsActive || latestAttentionAtDelta === 0
    ? compareByCreatedAtDescending(left, right)
    : latestAttentionAtDelta;
}

function comparePinnedRoots(left: SidebarThread, right: SidebarThread): number {
  if (left.pinSortKey !== null && right.pinSortKey !== null) {
    const pinSortKeyDelta = compareCodepoint(left.pinSortKey, right.pinSortKey);
    if (pinSortKeyDelta !== 0) return pinSortKeyDelta;
  }
  const pinnedAtDelta = (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0);
  return pinnedAtDelta !== 0
    ? pinnedAtDelta
    : compareByCreatedAtDescending(left, right);
}

export function flattenThreadNodes(
  nodes: readonly ThreadNode[],
): SidebarThread[] {
  return nodes.flatMap((node) => [
    node.thread,
    ...flattenThreadNodes(node.children),
  ]);
}

function groupByParentId(
  threads: readonly SidebarThread[],
  isKnownParent: (parentThreadId: string) => boolean,
): Map<string, SidebarThread[]> {
  const childrenByParentId = new Map<string, SidebarThread[]>();
  for (const thread of threads) {
    const parentId = thread.parentThreadId;
    if (parentId === null || !isKnownParent(parentId)) continue;
    const children = childrenByParentId.get(parentId);
    if (children) {
      children.push(thread);
    } else {
      childrenByParentId.set(parentId, [thread]);
    }
  }
  return childrenByParentId;
}

function buildThreadTree(
  allThreads: readonly SidebarThread[],
  compareThreads: ThreadComparator = compareStandardThreads,
  draftThreadIds: ReadonlySet<string> = new Set(),
): ThreadNode[] {
  const threads = allThreads.filter((thread) => !thread.isHidden);
  const threadIds = new Set(threads.map((thread) => thread.id));
  const childrenByParentId = groupByParentId(threads, (parentId) =>
    threadIds.has(parentId),
  );
  const visitedThreadIds = new Set<string>();

  const buildNode = (
    thread: SidebarThread,
    depth: number,
    ancestorThreadIds: ReadonlySet<string>,
  ): ThreadNode => {
    visitedThreadIds.add(thread.id);
    const lineage = new Set(ancestorThreadIds).add(thread.id);
    const children: ThreadNode[] = [];
    for (const child of childrenByParentId.get(thread.id) ?? []) {
      if (lineage.has(child.id) || visitedThreadIds.has(child.id)) continue;
      children.push(buildNode(child, depth + 1, lineage));
    }
    children.sort((left, right) => compareThreads(left.thread, right.thread));
    const hiddenThreads = flattenThreadNodes(children);
    return {
      thread,
      children,
      depth,
      childCount: hiddenThreads.length,
      childActivity: rollupThreadActivity(hiddenThreads, draftThreadIds),
    };
  };

  const rootNodes: ThreadNode[] = [];
  for (const thread of threads) {
    const isRoot =
      thread.parentThreadId === null || !threadIds.has(thread.parentThreadId);
    if (isRoot && !visitedThreadIds.has(thread.id)) {
      rootNodes.push(buildNode(thread, 0, new Set()));
    }
  }
  for (const thread of threads) {
    if (!visitedThreadIds.has(thread.id)) {
      rootNodes.push(buildNode(thread, 0, new Set()));
    }
  }
  return rootNodes.sort((left, right) =>
    compareThreads(left.thread, right.thread),
  );
}

export function buildSectionThreadList(
  threads: readonly SidebarThread[],
  compareThreads: ThreadComparator,
  sections: readonly SidebarSectionDefinition[],
  draftThreadIds: ReadonlySet<string> = new Set(),
): SectionThreadList {
  const nodesBySectionId = new Map<string, ThreadNode[]>(
    sections.map((section) => [section.id, []]),
  );
  const loose: ThreadNode[] = [];
  for (const node of buildThreadTree(threads, compareThreads, draftThreadIds)) {
    const sectionId = node.thread.sectionId;
    (sectionId ? nodesBySectionId.get(sectionId) : loose)?.push(node);
  }
  return {
    sections: sections.flatMap((section) => {
      const nodes = nodesBySectionId.get(section.id);
      if (nodes === undefined) return [];
      nodesBySectionId.delete(section.id);
      const sectionThreads = flattenThreadNodes(nodes);
      return [
        {
          id: section.id,
          key: buildSectionKey(CHRONOLOGICAL_CONTAINER_ID, section.id),
          name: section.name,
          nodes,
          threads: sectionThreads,
          activity: rollupThreadActivity(sectionThreads, draftThreadIds),
        },
      ];
    }),
    loose,
  };
}

export function collectEffectivePinnedThreadIds(
  threads: readonly SidebarThread[],
): Set<string> {
  const childrenByParentId = groupByParentId(threads, () => true);
  const effectivePinnedThreadIds = new Set<string>();
  const addWithDescendants = (thread: SidebarThread): void => {
    effectivePinnedThreadIds.add(thread.id);
    for (const child of childrenByParentId.get(thread.id) ?? []) {
      if (!effectivePinnedThreadIds.has(child.id)) addWithDescendants(child);
    }
  };
  for (const thread of threads) {
    if (thread.pinnedAt !== null) addWithDescendants(thread);
  }
  return effectivePinnedThreadIds;
}

export function buildPinnedThreadState(
  threads: readonly SidebarThread[],
  draftThreadIds: ReadonlySet<string> = new Set(),
): PinnedThreadState {
  const effectivePinnedThreadIds = collectEffectivePinnedThreadIds(threads);
  const rootNodes = buildThreadTree(
    threads.filter((thread) => effectivePinnedThreadIds.has(thread.id)),
    compareStandardThreads,
    draftThreadIds,
  ).sort((left, right) => comparePinnedRoots(left.thread, right.thread));
  return { effectivePinnedThreadIds, rootNodes };
}

export function getThreadComparator(
  sort: "updated" | "created" | "alpha" | "none",
  direction: "default" | "ascending" | "descending" = "default",
  renamingThread: { id: string; name: string } | null = null,
): ThreadComparator {
  const naturalDirection = sort === "alpha" ? "ascending" : "descending";
  const multiplier =
    direction === "default" || direction === naturalDirection ? 1 : -1;
  if (sort === "alpha") {
    const sortTitle = (thread: SidebarThread) =>
      renamingThread?.id === thread.id
        ? renamingThread.name
        : thread.displayTitle;
    return (left, right) =>
      multiplier *
      (sortTitle(left).localeCompare(sortTitle(right)) ||
        left.id.localeCompare(right.id));
  }
  if (sort === "created") {
    return (left, right) =>
      multiplier * compareByCreatedAtDescending(left, right);
  }
  return (left, right) => {
    const comparison = compareStandardThreads(left, right);
    return (left.status === "active") !== (right.status === "active")
      ? comparison
      : multiplier * comparison;
  };
}

export function countThreadNodeRows(
  node: ThreadNode,
  collapsedThreadIds: ReadonlySet<string>,
): number {
  return collapsedThreadIds.has(node.thread.id)
    ? 1
    : node.children.reduce(
        (total, child) =>
          total + countThreadNodeRows(child, collapsedThreadIds),
        1,
      );
}

export function collectThreadNavigationEntries(
  nodes: readonly ThreadNode[],
  collapsedThreadIds: ReadonlySet<string>,
): { threadId: string; projectId: string }[] {
  return nodes.flatMap((node) => [
    { threadId: node.thread.id, projectId: node.thread.projectId },
    ...(collapsedThreadIds.has(node.thread.id)
      ? []
      : collectThreadNavigationEntries(node.children, collapsedThreadIds)),
  ]);
}

export function threadNodeContains(
  node: ThreadNode,
  threadId: string,
): boolean {
  return (
    node.thread.id === threadId ||
    node.children.some((child) => threadNodeContains(child, threadId))
  );
}
