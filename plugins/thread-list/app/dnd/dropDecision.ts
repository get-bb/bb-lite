import type { ClientRect, Collision, UniqueIdentifier } from "@dnd-kit/core";
import {
  buildSidebarEntitySectionId,
  CHRONOLOGICAL_CONTAINER_ID,
  type NeighborReorderRequest,
  type SidebarSectionId,
} from "@bb/client-core";
import type {
  SectionThreadList,
  SidebarThread,
  ThreadNode,
} from "../model/thread-tree.js";

export const PINNED_THREAD_PARENT_KEY = "sidebar:pinned-threads";
const ROW_POINTER_SLACK_PX = 12;
export type SidebarReorderPlacement = "before" | "after";

export interface SectionThreadReorderTarget {
  threadId: string;
  placement: SidebarReorderPlacement;
}

interface SectionThreadDndLookup {
  sectionParentKeyBySectionId: Map<string, string>;
  sectionSectionIdByParentKey: Map<string, SidebarSectionId>;
  sectionIdByParentKey: Map<string, string | null>;
  itemIdsByParentKey: Map<string, string[]>;
  parentKeyByItemId: Map<string, string>;
  threadByItemId: Map<string, SidebarThread>;
  nestParentIdByItemId: Map<string, string>;
}

interface SectionThreadUpdate {
  threadId: string;
  parentThreadId?: null;
  sectionId?: string | null;
}

export interface SectionThreadDropChanges {
  threadId: string;
  unpin: boolean;
  update: SectionThreadUpdate | null;
  pin: boolean;
}

export type SectionThreadDropDecision =
  | ({ kind: "move"; toParentKey: string } & SectionThreadDropChanges)
  | ({ kind: "pin" } & SectionThreadDropChanges)
  | { kind: "reorder-pinned"; overId: string }
  | { kind: "unchanged"; toParentKey: string };

export function collectSectionThreadDndLookup(
  list: SectionThreadList,
  pinnedNodes: readonly ThreadNode[] = [],
): SectionThreadDndLookup {
  const lookup: SectionThreadDndLookup = {
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
    parentKeyByItemId: new Map(),
    threadByItemId: new Map(),
    nestParentIdByItemId: new Map(),
  };
  const registerNode = (
    node: ThreadNode,
    parentKey: string,
    nestParentId?: string,
  ) => {
    const threadId = node.thread.id;
    lookup.parentKeyByItemId.set(threadId, parentKey);
    lookup.threadByItemId.set(threadId, node.thread);
    if (nestParentId) lookup.nestParentIdByItemId.set(threadId, nestParentId);
    for (const child of node.children) {
      registerNode(child, parentKey, threadId);
    }
  };
  const registerRoots = (nodes: readonly ThreadNode[], parentKey: string) => {
    lookup.itemIdsByParentKey.set(
      parentKey,
      nodes.map((node) => node.thread.id),
    );
    for (const node of nodes) registerNode(node, parentKey);
  };
  registerRoots(pinnedNodes, PINNED_THREAD_PARENT_KEY);
  for (const section of list.sections) {
    const sectionId = buildSidebarEntitySectionId("section", section.id);
    lookup.sectionParentKeyBySectionId.set(sectionId, section.key);
    lookup.sectionSectionIdByParentKey.set(section.key, sectionId);
    lookup.sectionIdByParentKey.set(section.key, section.id);
    registerRoots(section.nodes, section.key);
  }
  for (const node of list.loose) {
    registerNode(node, CHRONOLOGICAL_CONTAINER_ID);
  }
  return lookup;
}

export function resolvePinnedInsertTarget(
  lookup: SectionThreadDndLookup,
  activeId: string | null,
  collisions: readonly Collision[],
  droppableRects: ReadonlyMap<UniqueIdentifier, ClientRect>,
  pointer: { x: number; y: number } | null,
): SectionThreadReorderTarget | null {
  if (activeId === null || pointer === null) return null;
  const row = collisions.find(
    ({ id }) => typeof id === "string" && lookup.threadByItemId.has(id),
  );
  const rect = row ? droppableRects.get(row.id) : undefined;
  if (!row || !rect || rect.height <= 0) return null;
  const threadId = String(row.id);
  const isPinnedRoot = (itemId: string) =>
    lookup.parentKeyByItemId.get(itemId) === PINNED_THREAD_PARENT_KEY &&
    !lookup.nestParentIdByItemId.has(itemId);
  if (
    pointer.x < rect.left - ROW_POINTER_SLACK_PX ||
    pointer.x > rect.left + rect.width ||
    pointer.y < rect.top ||
    pointer.y > rect.bottom ||
    isPinnedRoot(activeId) ||
    !isPinnedRoot(threadId)
  ) {
    return null;
  }
  return {
    threadId,
    placement: (pointer.y - rect.top) / rect.height < 0.5 ? "before" : "after",
  };
}

export function buildPinInsertRequest(
  lookup: SectionThreadDndLookup,
  threadId: string,
  target: SectionThreadReorderTarget,
): NeighborReorderRequest | null {
  const pinnedIds =
    lookup.itemIdsByParentKey.get(PINNED_THREAD_PARENT_KEY) ?? [];
  const index = pinnedIds.indexOf(target.threadId);
  if (index === -1 || threadId === target.threadId) return null;
  return target.placement === "before"
    ? {
        itemId: threadId,
        previousItemId: pinnedIds[index - 1] ?? null,
        nextItemId: target.threadId,
      }
    : {
        itemId: threadId,
        previousItemId: target.threadId,
        nextItemId: pinnedIds[index + 1] ?? null,
      };
}

function resolveSectionThreadDropParentKey(
  lookup: SectionThreadDndLookup,
  overId: string,
): string | null {
  const sectionParentKey = lookup.sectionParentKeyBySectionId.get(overId);
  if (sectionParentKey) return sectionParentKey;
  if (lookup.threadByItemId.has(overId)) {
    return lookup.parentKeyByItemId.get(overId) ?? null;
  }
  return lookup.sectionIdByParentKey.has(overId) ? overId : null;
}

export function resolveSectionThreadDropDecision(
  lookup: SectionThreadDndLookup,
  activeId: string,
  overId: string | null,
  projectedParentKey: string | null = null,
): SectionThreadDropDecision | null {
  const thread = lookup.threadByItemId.get(activeId);
  if (!thread || !lookup.parentKeyByItemId.has(activeId)) return null;
  const toParentKey =
    overId === activeId
      ? projectedParentKey
      : overId === null
        ? null
        : resolveSectionThreadDropParentKey(lookup, overId);
  if (!toParentKey) return null;

  const threadId = thread.id;
  const detach = lookup.nestParentIdByItemId.has(threadId);
  if (toParentKey === PINNED_THREAD_PARENT_KEY) {
    const pin = thread.pinnedAt === null;
    if (detach || pin) {
      return {
        kind: "pin",
        threadId,
        unpin: false,
        update: detach ? { threadId, parentThreadId: null } : null,
        pin,
      };
    }
    if (
      overId !== null &&
      overId !== activeId &&
      lookup.parentKeyByItemId.get(overId) === PINNED_THREAD_PARENT_KEY
    ) {
      return { kind: "reorder-pinned", overId };
    }
    return { kind: "unchanged", toParentKey };
  }

  if (!lookup.sectionIdByParentKey.has(toParentKey)) return null;
  const sectionId = lookup.sectionIdByParentKey.get(toParentKey) ?? null;
  const unpin = thread.pinnedAt !== null;
  const update: SectionThreadUpdate | null =
    detach || thread.sectionId !== sectionId
      ? detach
        ? { threadId, parentThreadId: null, sectionId }
        : { threadId, sectionId }
      : null;
  if (!unpin && update === null) return { kind: "unchanged", toParentKey };
  return { kind: "move", toParentKey, threadId, unpin, update, pin: false };
}

export function resolvePinnedReorderPlacement(
  lookup: SectionThreadDndLookup,
  activeId: string,
  overId: string,
): SidebarReorderPlacement | null {
  const pinnedIds =
    lookup.itemIdsByParentKey.get(PINNED_THREAD_PARENT_KEY) ?? [];
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

export function hasDropDecisionLanded(
  lookup: SectionThreadDndLookup,
  decision: Extract<SectionThreadDropDecision, { kind: "move" | "pin" }>,
): boolean {
  const toParentKey =
    decision.kind === "pin" ? PINNED_THREAD_PARENT_KEY : decision.toParentKey;
  return (
    lookup.parentKeyByItemId.get(decision.threadId) === toParentKey &&
    !lookup.nestParentIdByItemId.has(decision.threadId)
  );
}
