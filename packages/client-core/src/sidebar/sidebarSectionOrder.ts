import type { ThreadListEntry } from "@bb/domain";
import { arrayMove } from "../stored-order.js";

export type SidebarSectionId =
  | "pinned"
  | "threads"
  | `project:${string}`
  | `section:${string}`
  | `machine:${string}`;
export type CollapsibleSidebarSectionId = "pinned" | "threads";

export interface SidebarSectionDefinition {
  id: string;
  name: string;
}

export const CHRONOLOGICAL_CONTAINER_ID = "chronological";

export function isSidebarProjectThread(
  thread: Pick<ThreadListEntry, "visibility">,
): boolean {
  return thread.visibility !== "hidden";
}

export function buildSectionKey(
  containerId: string,
  sectionId: string,
): string {
  return `${containerId}::${sectionId}`;
}

export function buildSidebarEntitySectionId(
  kind: "project" | "section" | "machine",
  id: string,
): SidebarSectionId {
  return `${kind}:${id}`;
}

function isSidebarSectionId(value: string): value is SidebarSectionId {
  return /^(pinned$|threads$|project:|section:|machine:)/u.test(value);
}

export interface NeighborReorderRequest {
  itemId: string;
  nextItemId: string | null;
  previousItemId: string | null;
}

export function buildNeighborReorderRequest(args: {
  activeId: string;
  items: readonly { id: string }[];
  overId: string;
}): NeighborReorderRequest | null {
  const ids = args.items.map((item) => item.id);
  const from = ids.indexOf(args.activeId);
  const to = ids.indexOf(args.overId);
  if (args.activeId === args.overId || from === -1 || to === -1) return null;
  const reordered = arrayMove(ids, from, to);
  const movedIndex = reordered.indexOf(args.activeId);
  return {
    itemId: args.activeId,
    previousItemId: reordered[movedIndex - 1] ?? null,
    nextItemId: reordered[movedIndex + 1] ?? null,
  };
}

export function reorderSidebarSectionOrder(args: {
  activeId: string;
  overId: string;
  order: readonly SidebarSectionId[];
}): SidebarSectionId[] | null {
  const { activeId, overId, order } = args;
  const from = order.findIndex((id) => id === activeId);
  const to = order.findIndex((id) => id === overId);
  return !isSidebarSectionId(activeId) ||
    !isSidebarSectionId(overId) ||
    activeId === overId ||
    from === -1 ||
    to === -1
    ? null
    : arrayMove(order, from, to);
}

interface SectionOrderArgs {
  storedOrder: readonly string[];
  entitySectionIds: readonly SidebarSectionId[];
  legacyEntityAnchor: "projects" | "sections" | "machines";
}

export function normalizeSidebarSectionOrder({
  storedOrder,
  entitySectionIds,
  legacyEntityAnchor,
  hasPinnedSection,
  hasThreadsSection = true,
}: SectionOrderArgs & {
  hasPinnedSection: boolean;
  hasThreadsSection?: boolean;
}): SidebarSectionId[] {
  const available = new Set<string>([
    ...(hasPinnedSection ? ["pinned"] : []),
    ...entitySectionIds,
    ...(hasThreadsSection ? ["threads"] : []),
  ]);
  const normalized: SidebarSectionId[] = [];
  const append = (sectionId: SidebarSectionId) => {
    if (available.has(sectionId) && !normalized.includes(sectionId)) {
      normalized.push(sectionId);
    }
  };
  for (const storedId of storedOrder) {
    if (storedId === legacyEntityAnchor) entitySectionIds.forEach(append);
    else if (isSidebarSectionId(storedId)) append(storedId);
  }
  if (hasPinnedSection && !normalized.includes("pinned")) {
    normalized.unshift("pinned");
  }
  const missingEntities = entitySectionIds.filter(
    (sectionId) => !normalized.includes(sectionId),
  );
  if (missingEntities.length > 0) {
    const lastEntityIndex = normalized.reduce(
      (last, sectionId, index) =>
        entitySectionIds.includes(sectionId) ? index : last,
      -1,
    );
    const threadsIndex = normalized.indexOf("threads");
    const insertionIndex =
      lastEntityIndex >= 0
        ? lastEntityIndex + 1
        : threadsIndex >= 0 || storedOrder.includes(legacyEntityAnchor)
          ? Math.max(threadsIndex, 0)
          : normalized.length;
    normalized.splice(insertionIndex, 0, ...missingEntities);
  }
  if (hasThreadsSection && !normalized.includes("threads")) {
    normalized.push("threads");
  }
  return normalized;
}

export function insertSidebarSectionAfter(
  args: SectionOrderArgs & {
    anchorSectionId: SidebarSectionId;
    sectionId: SidebarSectionId;
  },
): SidebarSectionId[] | null {
  const { anchorSectionId, sectionId } = args;
  const normalized = normalizeSidebarSectionOrder({
    ...args,
    entitySectionIds: [...args.entitySectionIds, sectionId],
    hasPinnedSection: true,
  }).filter((id) => id !== sectionId);
  const anchorIndex = normalized.indexOf(anchorSectionId);
  if (anchorSectionId === sectionId || anchorIndex === -1) return null;
  normalized.splice(anchorIndex + 1, 0, sectionId);
  return normalized;
}
