import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEventHandler,
} from "react";
import { useSetAtom } from "jotai";
import { toast } from "sonner";
import {
  MeasuringStrategy,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  buildNeighborReorderRequest,
  CHRONOLOGICAL_CONTAINER_ID,
  reorderSidebarSectionOrder,
  type NeighborReorderRequest,
  type SidebarSectionId,
} from "@bb/client-core";
import { useSidebarThreadActions, useSdk } from "@bb/plugin/app";
import type { ConsumeDragClickSuppression } from "@bb/shared-ui/hooks/use-drag-click-suppression";
import {
  SIDEBAR_SECTION_DROP_TARGET_CLASS,
  SIDEBAR_SECTION_DROP_TARGET_UNCHANGED_CLASS,
} from "@bb/shared-ui/sidebar-row-classes";
import {
  reorderCollisionDetection,
  type ReorderDndContextProps,
} from "@bb/shared-ui/use-reorder-dnd";
import { useSidebarReorderDnd } from "@bb/shared-ui/use-sidebar-reorder-dnd";
import type {
  SectionThreadList,
  SidebarThread,
  ThreadNode,
} from "../model/thread-tree.js";
import { sidebarCollapsedThreadSectionsAtom } from "../preferences.js";
import {
  buildPinInsertRequest,
  collectSectionThreadDndLookup,
  hasDropDecisionLanded,
  PINNED_THREAD_PARENT_KEY,
  resolvePinnedInsertTarget,
  resolvePinnedReorderPlacement,
  resolveSectionThreadDropDecision,
  resolveSectionThreadSectionOverId,
  type SectionThreadDropChanges,
  type SectionThreadDropDecision,
  type SectionThreadReorderTarget,
} from "./dropDecision.js";

const SECTION_AUTO_EXPAND_MS = 200;

const SECTION_THREAD_DROPPABLE_MEASURING = {
  droppable: { strategy: MeasuringStrategy.WhileDragging, frequency: 16 },
};

export type PinnedThreadReorderHandler = (
  request: NeighborReorderRequest,
  callbacks: { onSettled: () => void },
) => void;

interface SectionThreadDndState {
  activeItemId: string | null;
  activeThread: SidebarThread | null;
  consumeClickSuppression: ConsumeDragClickSuppression;
  dndContextProps: ReorderDndContextProps;
  itemIdsByParentKey: ReadonlyMap<string, readonly string[]>;
  onClickCapture: MouseEventHandler<HTMLElement>;
  dragOverParentKey: string | null;
  unchangedParentKey: string | null;
  reorderTarget: SectionThreadReorderTarget | null;
  pinnedItemIds: readonly string[];
  pinnedReorderPending: boolean;
}

interface UseSectionThreadDndArgs {
  list: SectionThreadList;
  pinnedNodes: readonly ThreadNode[];
  topLevelSectionOrder: readonly SidebarSectionId[];
  onTopLevelSectionOrderChange: (order: SidebarSectionId[]) => void;
  pinnedReorderPending: boolean;
  onReorderPinnedThread: PinnedThreadReorderHandler;
}

function isPointerWithinSidebar(
  pointerCoordinates: { x: number; y: number } | null,
): boolean {
  if (
    pointerCoordinates === null ||
    typeof document.elementsFromPoint !== "function"
  ) {
    return true;
  }
  return document
    .elementsFromPoint(pointerCoordinates.x, pointerCoordinates.y)
    .some((element) => element.closest('[data-sidebar="sidebar"]') !== null);
}

function getEventIds(event: DragOverEvent | DragEndEvent) {
  return {
    activeId: typeof event.active.id === "string" ? event.active.id : null,
    overId: typeof event.over?.id === "string" ? event.over.id : null,
  };
}

export function useSectionThreadDnd({
  list,
  pinnedNodes,
  topLevelSectionOrder,
  onTopLevelSectionOrderChange,
  pinnedReorderPending,
  onReorderPinnedThread,
}: UseSectionThreadDndArgs): SectionThreadDndState {
  const lookup = useMemo(
    () => collectSectionThreadDndLookup(list, pinnedNodes),
    [list, pinnedNodes],
  );
  const topLevelSectionIds = useMemo(
    () => new Set<string>(topLevelSectionOrder),
    [topLevelSectionOrder],
  );
  const activeIdRef = useRef<string | null>(null);
  const pinnedInsertRef = useRef<SectionThreadReorderTarget | null>(null);
  const isPinnedRoot = useCallback(
    (itemId: string) =>
      lookup.parentKeyByItemId.get(itemId) === PINNED_THREAD_PARENT_KEY &&
      !lookup.nestParentIdByItemId.has(itemId),
    [lookup],
  );
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      if (!isPointerWithinSidebar(args.pointerCoordinates)) {
        pinnedInsertRef.current = null;
        return [];
      }
      if (
        typeof args.active.id === "string" &&
        topLevelSectionIds.has(args.active.id)
      ) {
        return reorderCollisionDetection({
          ...args,
          droppableContainers: args.droppableContainers.filter(({ id }) =>
            typeof id === "string" ? topLevelSectionIds.has(id) : false,
          ),
        });
      }
      const collisions = reorderCollisionDetection(args);
      pinnedInsertRef.current = resolvePinnedInsertTarget(
        lookup,
        activeIdRef.current,
        collisions,
        args.droppableRects,
        args.pointerCoordinates,
      );
      const nestedCollisions = collisions.filter(({ id }) =>
        typeof id === "string" ? !topLevelSectionIds.has(id) : true,
      );
      return nestedCollisions.length > 0 ? nestedCollisions : collisions;
    },
    [lookup, topLevelSectionIds],
  );
  const sdk = useSdk();
  const sidebarActions = useSidebarThreadActions();
  const setCollapsedSections = useSetAtom(sidebarCollapsedThreadSectionsAtom);
  const [activeThread, setActiveThread] = useState<SidebarThread | null>(null);
  const [dragOverParentKey, setDragOverParentKey] = useState<string | null>(
    null,
  );
  const [unchangedParentKey, setUnchangedParentKey] = useState<string | null>(
    null,
  );
  const [reorderTarget, setReorderTarget] =
    useState<SectionThreadReorderTarget | null>(null);
  const [pendingDropDecision, setPendingDropDecision] = useState<Extract<
    SectionThreadDropDecision,
    { kind: "move" | "pin" }
  > | null>(null);
  const draggingThreadRef = useRef(false);
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dwellTargetKeyRef = useRef<string | null>(null);

  const clearDropDwell = useCallback(() => {
    if (dwellTimerRef.current !== null) clearTimeout(dwellTimerRef.current);
    dwellTimerRef.current = null;
    dwellTargetKeyRef.current = null;
  }, []);
  const clearDropState = useCallback(() => {
    setActiveThread(null);
    setDragOverParentKey(null);
    setUnchangedParentKey(null);
    setReorderTarget(null);
    setPendingDropDecision(null);
    activeIdRef.current = null;
    pinnedInsertRef.current = null;
  }, []);

  useEffect(() => clearDropDwell, [clearDropDwell]);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const activeId =
        typeof event.active.id === "string" ? event.active.id : null;
      const thread = activeId
        ? (lookup.threadByItemId.get(activeId) ?? null)
        : null;
      draggingThreadRef.current = thread !== null;
      setPendingDropDecision(null);
      activeIdRef.current = thread ? activeId : null;
      pinnedInsertRef.current = null;
      clearDropDwell();
      setActiveThread(thread);
      setDragOverParentKey(null);
      setUnchangedParentKey(null);
      setReorderTarget(null);
    },
    [clearDropDwell, lookup],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      if (!draggingThreadRef.current) return;
      const { activeId, overId } = getEventIds(event);
      if (activeId === null) return;
      const decision = resolveSectionThreadDropDecision(
        lookup,
        activeId,
        overId,
        dragOverParentKey,
      );
      const targetParentKey =
        decision?.kind === "pin"
          ? PINNED_THREAD_PARENT_KEY
          : decision?.kind === "move"
            ? decision.toParentKey
            : null;
      const nextUnchangedParentKey =
        decision?.kind === "unchanged" ? decision.toParentKey : null;
      const placement =
        decision?.kind === "reorder-pinned"
          ? resolvePinnedReorderPlacement(lookup, activeId, decision.overId)
          : null;
      const nextReorderTarget =
        decision?.kind === "reorder-pinned" && placement
          ? { threadId: decision.overId, placement }
          : null;
      const targetKey =
        nextReorderTarget !== null
          ? `reorder:${nextReorderTarget.threadId}:${nextReorderTarget.placement}`
          : nextUnchangedParentKey !== null
            ? `unchanged:${nextUnchangedParentKey}`
            : targetParentKey;
      if (targetKey === dwellTargetKeyRef.current) return;

      clearDropDwell();
      dwellTargetKeyRef.current = targetKey;
      setDragOverParentKey(targetParentKey);
      setUnchangedParentKey(nextUnchangedParentKey);
      if (isPinnedRoot(activeId)) setReorderTarget(nextReorderTarget);
      if (
        targetParentKey === null ||
        targetParentKey === CHRONOLOGICAL_CONTAINER_ID ||
        targetParentKey === PINNED_THREAD_PARENT_KEY
      ) {
        return;
      }
      dwellTimerRef.current = setTimeout(() => {
        dwellTimerRef.current = null;
        if (
          draggingThreadRef.current &&
          dwellTargetKeyRef.current === targetKey
        ) {
          setCollapsedSections((current) =>
            current.includes(targetParentKey)
              ? current.filter((key) => key !== targetParentKey)
              : current,
          );
        }
      }, SECTION_AUTO_EXPAND_MS);
    },
    [
      clearDropDwell,
      dragOverParentKey,
      isPinnedRoot,
      lookup,
      setCollapsedSections,
    ],
  );

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      if (!draggingThreadRef.current) return;
      const activeId =
        typeof event.active.id === "string" ? event.active.id : null;
      if (activeId === null || isPinnedRoot(activeId)) return;
      const next = pinnedInsertRef.current;
      setReorderTarget((current) =>
        current?.threadId === next?.threadId &&
        current?.placement === next?.placement
          ? current
          : next,
      );
    },
    [isPinnedRoot],
  );

  const commitDropChanges = useCallback(
    async (changes: SectionThreadDropChanges, failureMessage: string) => {
      if (changes.unpin) {
        await sidebarActions.setPinned(changes.threadId, false);
      }
      if (changes.update) {
        try {
          await sdk.threads.update(changes.update);
        } catch (error) {
          toast.error(failureMessage);
          throw error;
        }
      }
      if (changes.pin) await sidebarActions.setPinned(changes.threadId, true);
    },
    [sdk, sidebarActions],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      draggingThreadRef.current = false;
      clearDropDwell();
      const { activeId, overId } = getEventIds(event);
      if (activeId === null) {
        clearDropState();
        return;
      }

      if (overId !== null && topLevelSectionIds.has(activeId)) {
        const nextOrder = reorderSidebarSectionOrder({
          activeId,
          overId: topLevelSectionIds.has(overId)
            ? overId
            : resolveSectionThreadSectionOverId(lookup, overId),
          order: topLevelSectionOrder,
        });
        if (nextOrder) onTopLevelSectionOrderChange(nextOrder);
        clearDropState();
        return;
      }

      const decision = resolveSectionThreadDropDecision(
        lookup,
        activeId,
        overId,
        dragOverParentKey,
      );
      if (decision?.kind === "reorder-pinned") {
        const pinnedIds =
          lookup.itemIdsByParentKey.get(PINNED_THREAD_PARENT_KEY) ?? [];
        const request =
          pinnedReorderPending || pinnedIds.length < 2
            ? null
            : buildNeighborReorderRequest({
                activeId,
                overId: decision.overId,
                items: pinnedIds.map((id) => ({ id })),
              });
        if (request) onReorderPinnedThread(request, { onSettled: () => {} });
      }
      if (decision?.kind !== "move" && decision?.kind !== "pin") {
        clearDropState();
        return;
      }
      const insertRequest =
        decision.kind === "pin" && reorderTarget
          ? buildPinInsertRequest(lookup, decision.threadId, reorderTarget)
          : null;
      void commitDropChanges(
        decision,
        decision.kind === "pin"
          ? "Failed to pin thread."
          : "Failed to move thread.",
      )
        .then(() => {
          if (insertRequest) {
            onReorderPinnedThread(insertRequest, { onSettled: () => {} });
          }
        })
        .catch(() => undefined)
        .finally(clearDropState);
      setPendingDropDecision(decision);
    },
    [
      clearDropDwell,
      clearDropState,
      commitDropChanges,
      dragOverParentKey,
      lookup,
      onReorderPinnedThread,
      onTopLevelSectionOrderChange,
      pinnedReorderPending,
      reorderTarget,
      topLevelSectionIds,
      topLevelSectionOrder,
    ],
  );

  const handleDragCancel = useCallback(() => {
    draggingThreadRef.current = false;
    clearDropDwell();
    clearDropState();
  }, [clearDropDwell, clearDropState]);

  const { consumeClickSuppression, dndContextProps, onClickCapture } =
    useSidebarReorderDnd({
      axis: "free",
      collisionDetection,
      measuring: SECTION_THREAD_DROPPABLE_MEASURING,
      onDragEnd: handleDragEnd,
      onDragStart: handleDragStart,
      onDragMove: handleDragMove,
      onDragOver: handleDragOver,
      onDragCancel: handleDragCancel,
    });

  const landed =
    pendingDropDecision !== null &&
    hasDropDecisionLanded(lookup, pendingDropDecision);
  const hideParentTarget = landed || reorderTarget !== null;
  return {
    activeItemId: landed ? null : activeIdRef.current,
    activeThread: landed ? null : activeThread,
    consumeClickSuppression,
    dndContextProps,
    itemIdsByParentKey: lookup.itemIdsByParentKey,
    onClickCapture,
    dragOverParentKey: hideParentTarget ? null : dragOverParentKey,
    unchangedParentKey: hideParentTarget ? null : unchangedParentKey,
    reorderTarget: landed ? null : reorderTarget,
    pinnedItemIds:
      lookup.itemIdsByParentKey.get(PINNED_THREAD_PARENT_KEY) ?? [],
    pinnedReorderPending,
  };
}

const SectionThreadDndContext = createContext<SectionThreadDndState | null>(
  null,
);

export const SectionThreadDndProvider = SectionThreadDndContext.Provider;

export function useSectionThreadDndState(): SectionThreadDndState {
  const state = useContext(SectionThreadDndContext);
  if (state === null) throw new Error("thread list drag state is missing");
  return state;
}

type SidebarSectionDropState = "active" | "unchanged";

export function useSectionDropTargetState(
  parentKey: string | undefined,
): SidebarSectionDropState | null {
  const sectionDnd = useSectionThreadDndState();
  if (parentKey === undefined || !sectionDnd.activeThread) return null;
  if (sectionDnd.dragOverParentKey === parentKey) return "active";
  if (sectionDnd.unchangedParentKey === parentKey) return "unchanged";
  return null;
}

export function SectionDropTargetOverlay({
  state,
}: {
  state: SidebarSectionDropState;
}) {
  return (
    <span
      aria-hidden="true"
      data-sidebar-drop-target-overlay=""
      className={
        state === "active"
          ? SIDEBAR_SECTION_DROP_TARGET_CLASS
          : SIDEBAR_SECTION_DROP_TARGET_UNCHANGED_CLASS
      }
    />
  );
}
