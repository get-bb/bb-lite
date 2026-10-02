import type { RefCallback } from "react";
import type { ClientRect, Collision, UniqueIdentifier } from "@dnd-kit/core";
import {
  buildSidebarEntitySectionId,
  CHRONOLOGICAL_CONTAINER_ID,
  type NeighborReorderRequest,
  type SidebarSectionId,
} from "@bb/client-core";
import {
  flattenThreadItems,
  getThreadItemDndId,
  type SectionThreadList,
  type SidebarThread,
  type ThreadItem,
  type ThreadNode,
} from "../model/thread-tree.js";

const SIDEBAR_THREAD_ROW_DROPPABLE_PREFIX = "sidebar:thread-row:";

export type SidebarNestTargetState = "valid" | "blocked" | "unchanged";

export type SidebarReorderPlacement = "before" | "after";

export interface ThreadRowNestDrop {
  setNodeRef: RefCallback<HTMLDivElement>;
  state: SidebarNestTargetState | null;
  reorderPlacement: SidebarReorderPlacement | null;
}

export function getSidebarThreadRowDroppableId(threadId: string): string {
  return `${SIDEBAR_THREAD_ROW_DROPPABLE_PREFIX}${threadId}`;
}

export function parseSidebarThreadRowDroppableId(id: string): string | null {
  return id.startsWith(SIDEBAR_THREAD_ROW_DROPPABLE_PREFIX)
    ? id.slice(SIDEBAR_THREAD_ROW_DROPPABLE_PREFIX.length)
    : null;
}

export const PINNED_THREAD_PARENT_KEY = "sidebar:pinned-threads";
const NEST_CANCEL_OFFSET_PX = 12;

export interface SectionThreadNestTarget {
  threadId: string;
  state: SidebarNestTargetState;
}

export interface SectionThreadReorderTarget {
  threadId: string;
  placement: SidebarReorderPlacement;
}

interface SectionThreadDndLookup {
  groupThreadsByItemId: Map<string, SidebarThread[]>;
  rootThreadIdsByItemId: Map<string, string[]>;
  pinnedThreadIds: string[];
  sectionParentKeyBySectionId: Map<string, string>;
  sectionSectionIdByParentKey: Map<string, SidebarSectionId>;
  sectionIdByParentKey: Map<string, string | null>;
  itemIdsByParentKey: Map<string, string[]>;
  itemKindById: Map<string, ThreadItem["kind"] | "section">;
  parentKeyByItemId: Map<string, string>;
  threadByItemId: Map<string, SidebarThread>;
  nodeByItemId: Map<string, ThreadNode>;
  nestParentIdByItemId: Map<string, string>;
}

interface SectionThreadUpdate {
  threadId: string;
  parentThreadId?: string | null;
  sectionId?: string | null;
}

interface SectionThreadDropChanges {
  activeId: string;
  threadIds: string[];
  unpinThreadIds: string[];
  updates: SectionThreadUpdate[];
  pinThreadIds: string[];
}

export type SectionThreadDropDecision =
  | ({ kind: "move"; toParentKey: string } & SectionThreadDropChanges)
  | ({ kind: "nest"; parentThreadId: string } & SectionThreadDropChanges)
  | ({ kind: "pin" } & SectionThreadDropChanges)
  | { kind: "reorder-pinned"; activeId: string; overId: string }
  | {
      kind: "rejected";
      activeId: string;
      overThreadId: string;
      reason: "own-subtree" | "already-child";
    }
  | { kind: "unchanged"; activeId: string; toParentKey: string };

export interface ThreadRowPointerInfo {
  threadId: string;
  relativeY: number;
  nesting: boolean;
}

export interface ResolvedThreadRowInfo {
  threadId: string;
  rect: ClientRect;
  retaining: boolean;
}

interface ResolveThreadRowNestCollisionsArgs {
  collisions: Collision[];
  droppableRects: ReadonlyMap<UniqueIdentifier, ClientRect>;
  pointerCoordinates: { x: number; y: number } | null;
  getBandFraction: (threadId: string) => number | null;
  retainedRect?: ClientRect | null;
  retainedThreadId?: string | null;
  onRowPointer?: (info: ThreadRowPointerInfo) => void;
  onResolvedRow?: (info: ResolvedThreadRowInfo) => void;
  holdNestCandidate?: (threadId: string | null) => boolean;
}

export type RowDropState = SectionThreadNestTarget;

export function collectSectionThreadDndLookup(
  list: SectionThreadList,
  pinnedRootItems: readonly ThreadItem[] = [],
  pinnedRootNodes: readonly ThreadNode[] = [],
): SectionThreadDndLookup {
  const pinnedThreads = pinnedRootNodes.map((node) => node.thread);
  const lookup: SectionThreadDndLookup = {
    groupThreadsByItemId: new Map(),
    rootThreadIdsByItemId: new Map(),
    pinnedThreadIds: pinnedThreads.map((thread) => thread.id),
    sectionParentKeyBySectionId: new Map([
      ["threads", CHRONOLOGICAL_CONTAINER_ID],
      ["pinned", PINNED_THREAD_PARENT_KEY],
    ]),
    sectionSectionIdByParentKey: new Map([
      [CHRONOLOGICAL_CONTAINER_ID, "threads"],
      [PINNED_THREAD_PARENT_KEY, "pinned"],
    ]),
    sectionIdByParentKey: new Map([[CHRONOLOGICAL_CONTAINER_ID, null]]),
    itemIdsByParentKey: new Map(),
    itemKindById: new Map(),
    parentKeyByItemId: new Map(),
    threadByItemId: new Map(),
    nodeByItemId: new Map(),
    nestParentIdByItemId: new Map(),
  };

  const registerNode = (
    node: ThreadNode,
    parentKey: string,
    nestParentId?: string,
  ) => {
    const threadId = node.thread.id;
    lookup.itemKindById.set(threadId, "thread");
    lookup.parentKeyByItemId.set(threadId, parentKey);
    lookup.threadByItemId.set(threadId, node.thread);
    lookup.nodeByItemId.set(threadId, node);
    if (nestParentId) lookup.nestParentIdByItemId.set(threadId, nestParentId);
    registerNestedChildren(node, parentKey);
  };
  const registerEnvironment = (
    item: Extract<ThreadItem, { kind: "environment" }>,
    parentKey: string,
    nestParentId?: string,
  ) => {
    const itemId = getThreadItemDndId(item);
    lookup.itemKindById.set(itemId, "environment");
    lookup.parentKeyByItemId.set(itemId, parentKey);
    lookup.groupThreadsByItemId.set(itemId, flattenThreadItems([item]));
    lookup.rootThreadIdsByItemId.set(
      itemId,
      item.group.nodes.map((node) => node.thread.id),
    );
    lookup.threadByItemId.set(itemId, item.group.nodes[0].thread);
    for (const node of item.group.nodes)
      registerNode(node, parentKey, nestParentId);
  };
  const registerNestedChildren = (node: ThreadNode, parentKey: string) => {
    for (const child of node.children) {
      if (child.kind === "thread")
        registerNode(child.node, parentKey, node.thread.id);
      else if (child.kind === "environment")
        registerEnvironment(child, parentKey, node.thread.id);
    }
  };

  for (const thread of pinnedThreads) {
    lookup.itemKindById.set(thread.id, "thread");
    lookup.parentKeyByItemId.set(thread.id, PINNED_THREAD_PARENT_KEY);
    lookup.threadByItemId.set(thread.id, thread);
  }
  for (const node of pinnedRootNodes) {
    lookup.nodeByItemId.set(node.thread.id, node);
    registerNestedChildren(node, PINNED_THREAD_PARENT_KEY);
  }

  const walk = (siblingItems: readonly ThreadItem[], parentKey: string) => {
    lookup.itemIdsByParentKey.set(
      parentKey,
      siblingItems.map(getThreadItemDndId),
    );
    for (const item of siblingItems) {
      const itemId = getThreadItemDndId(item);
      lookup.itemKindById.set(itemId, item.kind);
      lookup.parentKeyByItemId.set(itemId, parentKey);
      if (item.kind === "thread") {
        registerNode(item.node, parentKey);
      } else {
        registerEnvironment(item, parentKey);
      }
    }
  };

  walk(pinnedRootItems, PINNED_THREAD_PARENT_KEY);
  for (const section of list.sections) {
    const sectionId = buildSidebarEntitySectionId("section", section.id);
    lookup.itemKindById.set(section.key, "section");
    lookup.parentKeyByItemId.set(section.key, CHRONOLOGICAL_CONTAINER_ID);
    lookup.sectionParentKeyBySectionId.set(sectionId, section.key);
    lookup.sectionSectionIdByParentKey.set(section.key, sectionId);
    lookup.sectionIdByParentKey.set(section.key, section.id);
    walk(section.items, section.key);
  }
  walk(list.loose, CHRONOLOGICAL_CONTAINER_ID);
  return lookup;
}

function isThreadWithinSubtree(
  lookup: SectionThreadDndLookup,
  rootThreadId: string,
  candidateThreadId: string,
): boolean {
  if (rootThreadId === candidateThreadId) return true;
  const stack: ThreadItem[] = [
    ...(lookup.nodeByItemId.get(rootThreadId)?.children ?? []),
  ];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) continue;
    if (item.kind === "thread") {
      if (item.node.thread.id === candidateThreadId) return true;
      stack.push(...item.node.children);
    } else if (item.kind === "environment") {
      for (const node of item.group.nodes) {
        if (node.thread.id === candidateThreadId) return true;
        stack.push(...node.children);
      }
    }
  }
  return false;
}

export function resolveThreadRowNestCollisions({
  collisions,
  droppableRects,
  pointerCoordinates,
  getBandFraction,
  retainedRect = null,
  retainedThreadId = null,
  onRowPointer,
  onResolvedRow,
  holdNestCandidate = (threadId) => threadId !== null,
}: ResolveThreadRowNestCollisionsArgs): Collision[] {
  let rowCollision: Collision | null = null;
  let rowThreadId: string | null = null;
  let rowRect: ClientRect | undefined;
  const otherCollisions: Collision[] = [];
  for (const collision of collisions) {
    const threadId =
      typeof collision.id === "string"
        ? parseSidebarThreadRowDroppableId(collision.id)
        : null;
    if (threadId === null) {
      otherCollisions.push(collision);
    } else if (rowCollision === null) {
      rowCollision = collision;
      rowThreadId = threadId;
      rowRect = droppableRects.get(collision.id);
    }
  }
  const retaining = rowCollision === null && retainedThreadId !== null;
  if (retaining) {
    rowCollision = { id: getSidebarThreadRowDroppableId(retainedThreadId) };
    rowThreadId = retainedThreadId;
    rowRect = droppableRects.get(rowCollision.id);
  }
  const rowPointer =
    rowCollision === null || rowThreadId === null || rowRect === undefined
      ? null
      : locateThreadRowPointer(
          rowThreadId,
          rowRect,
          pointerCoordinates,
          getBandFraction,
          retaining,
          retainedRect,
        );
  if (rowPointer && rowRect) {
    onResolvedRow?.({
      threadId: rowPointer.threadId,
      rect: rowRect,
      retaining,
    });
  }
  const candidateThreadId = rowPointer?.inNestBand ? rowPointer.threadId : null;
  const nesting =
    holdNestCandidate(candidateThreadId) && candidateThreadId !== null;
  if (rowPointer) {
    onRowPointer?.({
      threadId: rowPointer.threadId,
      relativeY: rowPointer.relativeY,
      nesting,
    });
  }
  return nesting && rowCollision !== null
    ? [rowCollision, ...otherCollisions]
    : otherCollisions;
}

function locateThreadRowPointer(
  threadId: string,
  rect: ClientRect | undefined,
  pointerCoordinates: { x: number; y: number } | null,
  getBandFraction: (threadId: string) => number | null,
  retainBelow: boolean,
  retainedRect: ClientRect | null,
): {
  threadId: string;
  relativeY: number;
  inNestBand: boolean;
} | null {
  if (!rect || rect.height <= 0 || !pointerCoordinates) return null;
  const { x, y } = pointerCoordinates;
  const withinX =
    x >= rect.left - NEST_CANCEL_OFFSET_PX && x <= rect.left + rect.width;
  const withinY = y >= rect.top && y <= rect.bottom;
  const withinRetainedRegion =
    retainBelow &&
    ((retainedRect !== null &&
      y >= Math.min(rect.top, retainedRect.top) &&
      y <= Math.max(rect.bottom, retainedRect.bottom)) ||
      (y > rect.bottom && y <= rect.bottom + rect.height));
  if (!withinX || (!withinY && !withinRetainedRegion)) return null;
  const relativeY = (y - rect.top) / rect.height;
  const bandFraction = getBandFraction(threadId);
  const inDwellBand =
    bandFraction !== null && Math.abs(relativeY - 0.5) <= bandFraction / 2;
  const movedLeft = x < rect.left - NEST_CANCEL_OFFSET_PX;
  if (withinRetainedRegion) {
    return {
      threadId,
      relativeY: 1,
      inNestBand: !movedLeft,
    };
  }
  return { threadId, relativeY, inNestBand: !movedLeft && inDwellBand };
}

export function buildPinInsertRequests(
  lookup: SectionThreadDndLookup,
  threadIds: readonly string[],
  target: SectionThreadReorderTarget,
): NeighborReorderRequest[] {
  const pinnedIds = lookup.pinnedThreadIds;
  const index = pinnedIds.indexOf(target.threadId);
  if (index === -1 || threadIds.includes(target.threadId)) return [];
  let previousItemId =
    target.placement === "before"
      ? (pinnedIds[index - 1] ?? null)
      : target.threadId;
  const nextItemId =
    target.placement === "before"
      ? target.threadId
      : (pinnedIds[index + 1] ?? null);
  return threadIds.map((itemId) => {
    const request = { itemId, previousItemId, nextItemId };
    previousItemId = itemId;
    return request;
  });
}

function resolveSectionThreadDropParentKey(
  lookup: SectionThreadDndLookup,
  overId: string | null,
): string | null {
  if (overId === null) return null;
  const overKind = lookup.itemKindById.get(overId);
  let parentKey = overKind ? lookup.parentKeyByItemId.get(overId) : undefined;
  const sectionParentKey = lookup.sectionParentKeyBySectionId.get(overId);
  if (sectionParentKey) parentKey = sectionParentKey;
  if (!overKind && lookup.sectionIdByParentKey.has(overId)) {
    parentKey = overId;
  } else if (overKind === "section") {
    parentKey = overId;
  }
  return parentKey ?? null;
}

function getPinnedThreadIds(threads: readonly SidebarThread[]): string[] {
  return threads
    .filter((thread) => thread.pinnedAt !== null)
    .map((thread) => thread.id);
}

function resolveNestDecision(
  lookup: SectionThreadDndLookup,
  activeId: string,
  threads: readonly SidebarThread[],
  parentThreadId: string,
): SectionThreadDropDecision | null {
  const parentThread = lookup.threadByItemId.get(parentThreadId);
  const parentKey = lookup.parentKeyByItemId.get(parentThreadId);
  if (!parentThread || !parentKey) return null;
  if (
    threads.some((thread) =>
      isThreadWithinSubtree(lookup, thread.id, parentThreadId),
    )
  ) {
    return {
      kind: "rejected",
      activeId,
      overThreadId: parentThreadId,
      reason: "own-subtree",
    };
  }
  if (
    threads.every(
      (thread) => lookup.nestParentIdByItemId.get(thread.id) === parentThreadId,
    )
  ) {
    return {
      kind: "rejected",
      activeId,
      overThreadId: parentThreadId,
      reason: "already-child",
    };
  }
  const sectionId =
    parentKey === PINNED_THREAD_PARENT_KEY
      ? (parentThread.sectionId ?? null)
      : (lookup.sectionIdByParentKey.get(parentKey) ?? null);
  return {
    kind: "nest",
    activeId,
    parentThreadId,
    threadIds: threads.map((thread) => thread.id),
    unpinThreadIds: getPinnedThreadIds(threads),
    updates: threads.map((thread) => ({
      threadId: thread.id,
      parentThreadId,
      sectionId,
    })),
    pinThreadIds: [],
  };
}

function resolveDraggedRootThreads(
  lookup: SectionThreadDndLookup,
  activeId: string,
): SidebarThread[] | null {
  const threads: SidebarThread[] = [];
  for (const threadId of lookup.rootThreadIdsByItemId.get(activeId) ?? [
    activeId,
  ]) {
    const thread = lookup.threadByItemId.get(threadId);
    if (!thread) return null;
    threads.push(thread);
  }
  return threads;
}

export function getGroupDragPreviewThread(
  thread: SidebarThread,
  groupThreads: readonly SidebarThread[],
): SidebarThread & { displayTitle: string } {
  const title = `${thread.environment?.name ?? thread.environment?.branchName ?? "Worktree group"} (${groupThreads.length} threads)`;
  return { ...thread, title, titleFallback: title, displayTitle: title };
}

export function resolveSectionThreadDropDecision(
  lookup: SectionThreadDndLookup,
  activeId: string,
  overId: string | null,
  projectedParentKey: string | null = null,
  projectedNestParentId: string | null = null,
): SectionThreadDropDecision | null {
  const fromParentKey = lookup.parentKeyByItemId.get(activeId);
  const threads = resolveDraggedRootThreads(lookup, activeId);
  if (!fromParentKey || !threads) return null;

  const overRowThreadId =
    overId === null ? null : parseSidebarThreadRowDroppableId(overId);
  if (overRowThreadId !== null && overRowThreadId !== activeId) {
    return resolveNestDecision(lookup, activeId, threads, overRowThreadId);
  }
  const isSelfCollision = overId === activeId || overRowThreadId === activeId;
  if (isSelfCollision && projectedNestParentId !== null) {
    return resolveNestDecision(
      lookup,
      activeId,
      threads,
      projectedNestParentId,
    );
  }

  const directParentKey = isSelfCollision
    ? null
    : resolveSectionThreadDropParentKey(lookup, overId);
  const toParentKey =
    directParentKey ?? (isSelfCollision ? projectedParentKey : null);
  if (!toParentKey) return null;

  const threadIds = threads.map((thread) => thread.id);
  if (toParentKey === PINNED_THREAD_PARENT_KEY) {
    const detachThreadIds = threadIds.filter((threadId) =>
      lookup.nestParentIdByItemId.has(threadId),
    );
    const pinThreadIds = threads
      .filter((thread) => thread.pinnedAt === null)
      .map((thread) => thread.id);
    if (detachThreadIds.length > 0 || pinThreadIds.length > 0) {
      return {
        kind: "pin",
        activeId,
        threadIds,
        unpinThreadIds: [],
        updates: detachThreadIds.map((threadId) => ({
          threadId,
          parentThreadId: null,
        })),
        pinThreadIds,
      };
    }
    if (
      overId !== null &&
      overId !== activeId &&
      lookup.itemKindById.get(activeId) === "thread" &&
      lookup.parentKeyByItemId.get(overId) === PINNED_THREAD_PARENT_KEY
    ) {
      return { kind: "reorder-pinned", activeId, overId };
    }
    return { kind: "unchanged", activeId, toParentKey };
  }

  if (!lookup.sectionIdByParentKey.has(toParentKey)) return null;
  const sectionId = lookup.sectionIdByParentKey.get(toParentKey) ?? null;
  const unpinThreadIds = getPinnedThreadIds(threads);
  const updates = threads.flatMap((thread): SectionThreadUpdate[] => {
    const detach = lookup.nestParentIdByItemId.has(thread.id);
    if (!detach && thread.sectionId === sectionId) return [];
    return [
      detach
        ? { threadId: thread.id, parentThreadId: null, sectionId }
        : { threadId: thread.id, sectionId },
    ];
  });
  if (unpinThreadIds.length === 0 && updates.length === 0) {
    return { kind: "unchanged", activeId, toParentKey };
  }
  return {
    kind: "move",
    activeId,
    toParentKey,
    threadIds,
    unpinThreadIds,
    updates,
    pinThreadIds: [],
  };
}

function resolvePinnedReorderPlacement(
  lookup: SectionThreadDndLookup,
  activeId: string,
  overId: string,
): SidebarReorderPlacement | null {
  const pinnedIds = lookup.itemIdsByParentKey.get(PINNED_THREAD_PARENT_KEY);
  if (!pinnedIds) return null;
  const activeIndex = pinnedIds.indexOf(activeId);
  const overIndex = pinnedIds.indexOf(overId);
  if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) {
    return null;
  }
  return activeIndex < overIndex ? "after" : "before";
}

export function resolveSectionThreadSectionOverId(
  lookup: SectionThreadDndLookup,
  overId: string,
): string {
  const overParentKey = lookup.parentKeyByItemId.get(overId);
  return (
    lookup.sectionSectionIdByParentKey.get(overId) ??
    (overParentKey
      ? lookup.sectionSectionIdByParentKey.get(overParentKey)
      : undefined) ??
    overId
  );
}

export function resolveRowDropState(
  decision: SectionThreadDropDecision | null,
): RowDropState | null {
  if (decision?.kind === "nest") {
    return { threadId: decision.parentThreadId, state: "valid" };
  }
  if (decision?.kind === "rejected") {
    return {
      threadId: decision.overThreadId,
      state: decision.reason === "own-subtree" ? "blocked" : "unchanged",
    };
  }
  return null;
}

export function resolvePinnedReorderTarget(
  lookup: SectionThreadDndLookup,
  activeId: string,
  decision: SectionThreadDropDecision | null,
): SectionThreadReorderTarget | null {
  if (decision?.kind !== "reorder-pinned") return null;
  const placement = resolvePinnedReorderPlacement(
    lookup,
    activeId,
    decision.overId,
  );
  return placement ? { threadId: decision.overId, placement } : null;
}

export function resolveTargetParentKey(
  decision: SectionThreadDropDecision | null,
): string | null {
  switch (decision?.kind) {
    case "pin":
      return PINNED_THREAD_PARENT_KEY;
    case "move":
      return decision.toParentKey;
    default:
      return null;
  }
}

export function resolveUnchangedParentKey(
  decision: SectionThreadDropDecision | null,
): string | null {
  return decision?.kind === "unchanged" ? decision.toParentKey : null;
}

export function getRowDropTargetKey(rowDrop: RowDropState): string {
  return `row:${rowDrop.threadId}:${rowDrop.state}`;
}

export function hasDropDecisionLanded(
  lookup: SectionThreadDndLookup,
  decision: SectionThreadDropDecision,
): boolean {
  switch (decision.kind) {
    case "move":
    case "pin": {
      const toParentKey =
        decision.kind === "pin"
          ? PINNED_THREAD_PARENT_KEY
          : decision.toParentKey;
      return decision.threadIds.every(
        (threadId) =>
          lookup.parentKeyByItemId.get(threadId) === toParentKey &&
          !lookup.nestParentIdByItemId.has(threadId),
      );
    }
    case "nest":
      return decision.threadIds.every(
        (threadId) =>
          lookup.nestParentIdByItemId.get(threadId) === decision.parentThreadId,
      );
    case "reorder-pinned":
    case "rejected":
    case "unchanged":
      return true;
  }
}
