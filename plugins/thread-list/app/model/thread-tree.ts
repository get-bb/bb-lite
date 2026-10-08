import {
  buildSectionKey,
  CHRONOLOGICAL_CONTAINER_ID,
  compareCodepoint,
  type SidebarSectionDefinition,
  type ThreadListIndicatorState,
} from "@bb/client-core";
import type { SidebarThread } from "@bb/plugin/app";
import { rollupThreadActivity } from "./thread-activity.js";

export type { SidebarThread };

export interface ThreadNode {
  thread: SidebarThread;
  children: ThreadItem[];
  depth: number;
  childCount: number;
  childActivity: ThreadListIndicatorState;
}

export interface EnvironmentThreadGroup {
  environmentId: string;
  environmentProviderId: string | null;
  nodes: [ThreadNode, ThreadNode, ...ThreadNode[]];
  childActivity: ThreadListIndicatorState;
}

export type ThreadItem =
  | { kind: "thread"; node: ThreadNode }
  | { kind: "environment"; group: EnvironmentThreadGroup };

export interface SectionGroup {
  id: string;
  key: string;
  name: string;
  items: ThreadItem[];
  threads: SidebarThread[];
  activity: ThreadListIndicatorState;
}

export interface SectionThreadList {
  sections: SectionGroup[];
  loose: ThreadItem[];
}

interface PinnedThreadState {
  effectivePinnedThreadIds: Set<string>;
  rootItems: ThreadItem[];
  rootNodes: ThreadNode[];
}

export type ThreadComparator = (
  left: SidebarThread,
  right: SidebarThread,
) => number;

interface ThreadTreeOptions {
  compareThreads: ThreadComparator;
  draftThreadIds: ReadonlySet<string>;
  groupEnvironmentThreads: boolean;
}

export interface CollapsedTreeState {
  collapsedThreadIds: ReadonlySet<string>;
  collapsedEnvironmentIds: ReadonlySet<string>;
}

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

export function threadItemNodes(item: ThreadItem): readonly ThreadNode[] {
  return item.kind === "thread" ? [item.node] : item.group.nodes;
}

export function threadItemThread(item: ThreadItem): SidebarThread {
  return item.kind === "thread" ? item.node.thread : item.group.nodes[0].thread;
}

export function getThreadItemKey(item: ThreadItem): string {
  return item.kind === "thread"
    ? `thread:${item.node.thread.id}`
    : `env:${item.group.environmentId}`;
}

export function getThreadItemDndId(item: ThreadItem): string {
  return item.kind === "thread"
    ? item.node.thread.id
    : `environment:${item.group.nodes[0].thread.id}`;
}

export function flattenThreadItems(
  items: readonly ThreadItem[],
): SidebarThread[] {
  return items.flatMap((item) =>
    threadItemNodes(item).flatMap((node) => [
      node.thread,
      ...flattenThreadItems(node.children),
    ]),
  );
}

function buildSortedItems(
  nodes: ThreadNode[],
  {
    compareThreads,
    draftThreadIds,
    groupEnvironmentThreads,
  }: ThreadTreeOptions,
): ThreadItem[] {
  const compareNodes = (left: ThreadNode, right: ThreadNode) =>
    compareThreads(left.thread, right.thread);
  if (!groupEnvironmentThreads) {
    return nodes.sort(compareNodes).map((node) => ({ kind: "thread", node }));
  }
  const nodesByEnvironmentId = new Map<string, ThreadNode[]>();
  const providerIdByEnvironmentId = new Map<string, string | null>();
  for (const node of nodes) {
    const environment = node.thread.environment;
    if (environment?.id == null || environment.isWorktree !== true) continue;
    providerIdByEnvironmentId.set(environment.id, environment.providerId);
    const bucket = nodesByEnvironmentId.get(environment.id);
    if (bucket) {
      bucket.push(node);
    } else {
      nodesByEnvironmentId.set(environment.id, [node]);
    }
  }
  const items: ThreadItem[] = [];
  const groupedEnvironmentIds = new Set<string>();
  for (const [environmentId, bucket] of nodesByEnvironmentId) {
    const [first, second, ...rest] = bucket.sort(compareNodes);
    if (first === undefined || second === undefined) continue;
    groupedEnvironmentIds.add(environmentId);
    const group: EnvironmentThreadGroup = {
      environmentId,
      environmentProviderId:
        providerIdByEnvironmentId.get(environmentId) ?? null,
      nodes: [first, second, ...rest],
      childActivity: rollupThreadActivity(
        flattenThreadItems(bucket.map((node) => ({ kind: "thread", node }))),
        draftThreadIds,
      ),
    };
    items.push({ kind: "environment", group });
  }
  for (const node of nodes) {
    const environmentId = node.thread.environment?.id ?? null;
    if (environmentId === null || !groupedEnvironmentIds.has(environmentId)) {
      items.push({ kind: "thread", node });
    }
  }
  return items.sort((left, right) =>
    compareThreads(threadItemThread(left), threadItemThread(right)),
  );
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

function buildRootNodes(
  allThreads: readonly SidebarThread[],
  options: ThreadTreeOptions,
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
    const childNodes: ThreadNode[] = [];
    for (const child of childrenByParentId.get(thread.id) ?? []) {
      if (lineage.has(child.id) || visitedThreadIds.has(child.id)) continue;
      childNodes.push(buildNode(child, depth + 1, lineage));
    }
    const children = buildSortedItems(childNodes, options);
    const hiddenThreads = flattenThreadItems(children);
    return {
      thread,
      children,
      depth,
      childCount: hiddenThreads.length,
      childActivity: rollupThreadActivity(
        hiddenThreads,
        options.draftThreadIds,
      ),
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
  return rootNodes;
}

export function buildSectionThreadList(
  threads: readonly SidebarThread[],
  compareThreads: ThreadComparator,
  sections: readonly SidebarSectionDefinition[],
  draftThreadIds: ReadonlySet<string> = new Set(),
  groupEnvironmentThreads = false,
): SectionThreadList {
  const options = { compareThreads, draftThreadIds, groupEnvironmentThreads };
  const nodesBySectionId = new Map<string, ThreadNode[]>(
    sections.map((section) => [section.id, []]),
  );
  const looseNodes: ThreadNode[] = [];
  for (const node of buildRootNodes(threads, options)) {
    const sectionId = node.thread.sectionId;
    (sectionId ? nodesBySectionId.get(sectionId) : looseNodes)?.push(node);
  }
  return {
    sections: sections.flatMap((section) => {
      const nodes = nodesBySectionId.get(section.id);
      if (nodes === undefined) return [];
      nodesBySectionId.delete(section.id);
      const items = buildSortedItems(nodes, options);
      const sectionThreads = flattenThreadItems(items);
      return [
        {
          id: section.id,
          key: buildSectionKey(CHRONOLOGICAL_CONTAINER_ID, section.id),
          name: section.name,
          items,
          threads: sectionThreads,
          activity: rollupThreadActivity(sectionThreads, draftThreadIds),
        },
      ];
    }),
    loose: buildSortedItems(looseNodes, options),
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
  groupEnvironmentThreads = false,
): PinnedThreadState {
  const effectivePinnedThreadIds = collectEffectivePinnedThreadIds(threads);
  const options = {
    compareThreads: compareStandardThreads,
    draftThreadIds,
    groupEnvironmentThreads,
  };
  const comparePinnedNodes = (left: ThreadNode, right: ThreadNode) =>
    comparePinnedRoots(left.thread, right.thread);
  const rootItems = buildSortedItems(
    buildRootNodes(
      threads.filter((thread) => effectivePinnedThreadIds.has(thread.id)),
      options,
    ),
    options,
  );
  for (const item of rootItems) {
    if (item.kind === "environment") item.group.nodes.sort(comparePinnedNodes);
  }
  rootItems.sort((left, right) =>
    comparePinnedRoots(threadItemThread(left), threadItemThread(right)),
  );
  return {
    effectivePinnedThreadIds,
    rootItems,
    rootNodes: rootItems.flatMap(threadItemNodes).sort(comparePinnedNodes),
  };
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

function isItemCollapsed(item: ThreadItem, state: CollapsedTreeState): boolean {
  return (
    item.kind === "environment" &&
    state.collapsedEnvironmentIds.has(item.group.environmentId)
  );
}

function visibleChildren(
  node: ThreadNode,
  state: CollapsedTreeState,
): readonly ThreadItem[] {
  return state.collapsedThreadIds.has(node.thread.id) ? [] : node.children;
}

export function countThreadItemRows(
  item: ThreadItem,
  state: CollapsedTreeState,
): number {
  if (isItemCollapsed(item, state)) return 1;
  return threadItemNodes(item).reduce(
    (total, node) =>
      visibleChildren(node, state).reduce(
        (rows, child) => rows + countThreadItemRows(child, state),
        total + 1,
      ),
    item.kind === "environment" ? 1 : 0,
  );
}

export function collectThreadNavigationEntries(
  items: readonly ThreadItem[],
  state: CollapsedTreeState,
): { threadId: string; projectId: string }[] {
  return items.flatMap((item) =>
    isItemCollapsed(item, state)
      ? []
      : threadItemNodes(item).flatMap((node) => [
          { threadId: node.thread.id, projectId: node.thread.projectId },
          ...collectThreadNavigationEntries(
            visibleChildren(node, state),
            state,
          ),
        ]),
  );
}

export function threadItemContains(
  item: ThreadItem,
  threadId: string,
): boolean {
  return threadItemNodes(item).some(
    (node) =>
      node.thread.id === threadId ||
      node.children.some((child) => threadItemContains(child, threadId)),
  );
}
