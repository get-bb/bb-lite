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
import { useAtomValue, useSetAtom } from "jotai";
import { toast } from "sonner";
import {
  MeasuringStrategy,
  type ClientRect,
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
  type SidebarSectionDefinition,
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
  useSidebarReorderDnd,
  type ReorderDndContextProps,
} from "@bb/shared-ui/use-reorder-dnd";
import type {
  SectionThreadList,
  SidebarThread,
  ThreadComparator,
  ThreadItem,
  ThreadNode,
} from "../model/thread-tree.js";
import {
  sidebarCollapsedThreadSectionsAtom,
  sidebarGroupThreadsByEnvironmentAtom,
} from "../preferences.js";
import {
  buildPinInsertRequests,
  collectSectionThreadDndLookup,
  getGroupDragPreviewThread,
  getRowDropTargetKey,
  getSidebarThreadRowDroppableId,
  hasDropDecisionLanded,
  parseSidebarThreadRowDroppableId,
  PINNED_THREAD_PARENT_KEY,
  resolvePinnedReorderTarget,
  resolveRowDropState,
  resolveSectionThreadDropDecision,
  resolveSectionThreadSectionOverId,
  resolveTargetParentKey,
  resolveThreadRowNestCollisions,
  resolveUnchangedParentKey,
  type ResolvedThreadRowInfo,
  type RowDropState,
  type SectionThreadDropDecision,
  type SectionThreadNestTarget,
  type SectionThreadReorderTarget,
  type ThreadRowPointerInfo,
} from "./dropDecision.js";
import { resolveSidebarNestPreviewBeforeKey } from "./nestPreview.js";

const NEST_BAND_FRACTION = 0.7;
const NEST_BAND_ARMED_FRACTION = 1;
const NEST_HOVER_DELAY_MS = 200;
const SECTION_AUTO_EXPAND_MS = 200;

const SECTION_THREAD_DROPPABLE_MEASURING = {
  droppable: { strategy: MeasuringStrategy.WhileDragging, frequency: 16 },
};

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
  nestTarget: SectionThreadNestTarget | null;
  nestPreviewBeforeKey: string | null;
  reorderTarget: SectionThreadReorderTarget | null;
  pinnedItemIds: readonly string[];
  pinnedReorderPending: boolean;
}

interface UseSectionThreadDndArgs {
  list: SectionThreadList;
  topLevelSectionOrder: readonly SidebarSectionId[];
  onTopLevelSectionOrderChange: (order: SidebarSectionId[]) => void;
  onExpandThread: (threadId: string) => void;
  pinnedReorderPending: boolean;
  pinnedRootItems: readonly ThreadItem[];
  pinnedRootNodes: readonly ThreadNode[];
  onReorderPinnedThread: PinnedThreadReorderHandler;
}

interface NestHoverCandidate {
  threadId: string;
}

interface RetainedNestTarget {
  threadId: string;
  rect: ClientRect;
}

function describeThreadCount(threadIds: readonly string[]): string {
  return threadIds.length === 1 ? "thread" : "threads";
}

function insertPinnedThreads(
  requests: readonly NeighborReorderRequest[],
  onReorderPinnedThread: PinnedThreadReorderHandler,
): Promise<void> {
  return requests.reduce<Promise<void>>(
    (previous, request) =>
      previous.then(
        () =>
          new Promise<void>((resolve) => {
            onReorderPinnedThread(request, { onSettled: resolve });
          }),
      ),
    Promise.resolve(),
  );
}

function getEventIds(event: DragOverEvent | DragEndEvent) {
  return {
    activeId: typeof event.active.id === "string" ? event.active.id : null,
    overId: typeof event.over?.id === "string" ? event.over.id : null,
  };
}

function resolveDwellExpansion({
  onExpandThread,
  rowDrop,
  setCollapsedSections,
  targetParentKey,
}: {
  onExpandThread: (threadId: string) => void;
  rowDrop: RowDropState | null;
  setCollapsedSections: (update: (current: string[]) => string[]) => void;
  targetParentKey: string | null;
}): (() => void) | null {
  if (rowDrop?.state === "valid") {
    const parentThreadId = rowDrop.threadId;
    return () => onExpandThread(parentThreadId);
  }
  if (
    targetParentKey === null ||
    targetParentKey === CHRONOLOGICAL_CONTAINER_ID ||
    targetParentKey === PINNED_THREAD_PARENT_KEY
  ) {
    return null;
  }
  return () =>
    setCollapsedSections((current) =>
      current.includes(targetParentKey)
        ? current.filter((key) => key !== targetParentKey)
        : current,
    );
}

export function useSectionThreadDnd({
  list,
  topLevelSectionOrder,
  onTopLevelSectionOrderChange,
  onExpandThread,
  pinnedReorderPending,
  pinnedRootItems,
  pinnedRootNodes,
  onReorderPinnedThread,
}: UseSectionThreadDndArgs): SectionThreadDndState {
  const lookup = useMemo(
    () => collectSectionThreadDndLookup(list, pinnedRootItems, pinnedRootNodes),
    [list, pinnedRootItems, pinnedRootNodes],
  );
  const topLevelSectionIds = useMemo(
    () => new Set<string>(topLevelSectionOrder),
    [topLevelSectionOrder],
  );
  const activeIdRef = useRef<string | null>(null);
  const armedNestThreadIdRef = useRef<string | null>(null);
  const latestRowCollisionRef = useRef<RetainedNestTarget | null>(null);
  const retainedNestTargetRef = useRef<RetainedNestTarget | null>(null);
  const pinnedInsertRef = useRef<SectionThreadReorderTarget | null>(null);
  const nestCandidateRef = useRef<NestHoverCandidate | null>(null);
  const nestCandidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [readyNestCandidate, setReadyNestCandidate] =
    useState<NestHoverCandidate | null>(null);
  const clearNestCandidate = useCallback(() => {
    if (nestCandidateTimerRef.current !== null) {
      clearTimeout(nestCandidateTimerRef.current);
    }
    nestCandidateTimerRef.current = null;
    nestCandidateRef.current = null;
  }, []);
  const holdNestCandidate = useCallback(
    (threadId: string | null): boolean => {
      const current = nestCandidateRef.current;
      if (current !== null && current.threadId === threadId) {
        return current === readyNestCandidate;
      }
      clearNestCandidate();
      if (threadId === null) return false;
      const candidate: NestHoverCandidate = { threadId };
      nestCandidateRef.current = candidate;
      nestCandidateTimerRef.current = setTimeout(() => {
        nestCandidateTimerRef.current = null;
        setReadyNestCandidate(candidate);
      }, NEST_HOVER_DELAY_MS);
      return false;
    },
    [clearNestCandidate, readyNestCandidate],
  );
  const isPinnedItem = useCallback(
    (itemId: string) =>
      lookup.parentKeyByItemId.get(itemId) === PINNED_THREAD_PARENT_KEY,
    [lookup],
  );
  const isPinnedRoot = useCallback(
    (itemId: string) =>
      isPinnedItem(itemId) && !lookup.nestParentIdByItemId.has(itemId),
    [isPinnedItem, lookup],
  );
  const getNestBandFraction = useCallback(
    (threadId: string): number | null => {
      const activeId = activeIdRef.current;
      if (activeId === null || threadId === activeId) return null;
      if (lookup.itemKindById.get(threadId) !== "thread") return null;
      const armed = armedNestThreadIdRef.current === threadId;
      return armed ? NEST_BAND_ARMED_FRACTION : NEST_BAND_FRACTION;
    },
    [lookup],
  );
  const handleRowPointer = useCallback(
    ({ threadId, relativeY, nesting }: ThreadRowPointerInfo) => {
      const activeId = activeIdRef.current;
      if (
        activeId === null ||
        nesting ||
        isPinnedRoot(activeId) ||
        !isPinnedRoot(threadId)
      ) {
        return;
      }
      pinnedInsertRef.current = {
        threadId,
        placement: relativeY < 0.5 ? "before" : "after",
      };
    },
    [isPinnedRoot],
  );
  const handleResolvedRow = useCallback(
    ({ threadId, rect, retaining }: ResolvedThreadRowInfo) => {
      if (!retaining) latestRowCollisionRef.current = { threadId, rect };
    },
    [],
  );
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      if (!isPointerWithinSidebar(args.pointerCoordinates)) {
        pinnedInsertRef.current = null;
        latestRowCollisionRef.current = null;
        return [];
      }
      if (
        typeof args.active.id === "string" &&
        topLevelSectionIds.has(args.active.id)
      ) {
        latestRowCollisionRef.current = null;
        return reorderCollisionDetection({
          ...args,
          droppableContainers: args.droppableContainers.filter(({ id }) =>
            typeof id === "string" ? topLevelSectionIds.has(id) : false,
          ),
        });
      }
      pinnedInsertRef.current = null;
      const groupThreads =
        typeof args.active.id === "string"
          ? lookup.groupThreadsByItemId.get(args.active.id)
          : undefined;
      const groupThreadIds = groupThreads
        ? new Set(groupThreads.map((thread) => thread.id))
        : null;
      const reorderCollisions = reorderCollisionDetection(
        groupThreadIds
          ? {
              ...args,
              droppableContainers: args.droppableContainers.filter(({ id }) => {
                if (typeof id !== "string") return true;
                const threadId =
                  parseSidebarThreadRowDroppableId(id) ??
                  lookup.threadByItemId.get(id)?.id;
                return threadId === undefined || !groupThreadIds.has(threadId);
              }),
            }
          : args,
      );
      latestRowCollisionRef.current = null;
      const retainedNestTarget = retainedNestTargetRef.current;
      const collisions = resolveThreadRowNestCollisions({
        collisions: reorderCollisions,
        droppableRects: args.droppableRects,
        pointerCoordinates: args.pointerCoordinates,
        getBandFraction: getNestBandFraction,
        retainedRect: retainedNestTarget?.rect,
        retainedThreadId: retainedNestTarget?.threadId,
        onRowPointer: handleRowPointer,
        onResolvedRow: handleResolvedRow,
        holdNestCandidate,
      });
      const nestedCollisions = collisions.filter(({ id }) =>
        typeof id === "string" ? !topLevelSectionIds.has(id) : true,
      );
      return nestedCollisions.length > 0 ? nestedCollisions : collisions;
    },
    [
      getNestBandFraction,
      handleResolvedRow,
      handleRowPointer,
      holdNestCandidate,
      lookup,
      topLevelSectionIds,
    ],
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
  const [rowDrop, setRowDrop] = useState<RowDropState | null>(null);
  const [reorderTarget, setReorderTarget] =
    useState<SectionThreadReorderTarget | null>(null);
  const [pendingDropDecision, setPendingDropDecision] =
    useState<SectionThreadDropDecision | null>(null);
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
    setRowDrop(null);
    setReorderTarget(null);
    setPendingDropDecision(null);
    setReadyNestCandidate(null);
    clearNestCandidate();
    armedNestThreadIdRef.current = null;
    latestRowCollisionRef.current = null;
    retainedNestTargetRef.current = null;
    activeIdRef.current = null;
    pinnedInsertRef.current = null;
  }, [clearNestCandidate]);
  const clearProjectedDrag = clearDropState;

  useEffect(
    () => () => {
      clearDropDwell();
      clearNestCandidate();
    },
    [clearDropDwell, clearNestCandidate],
  );

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
      armedNestThreadIdRef.current = null;
      latestRowCollisionRef.current = null;
      retainedNestTargetRef.current = null;
      pinnedInsertRef.current = null;
      clearDropDwell();
      clearNestCandidate();
      const groupThreads = activeId
        ? lookup.groupThreadsByItemId.get(activeId)
        : undefined;
      setActiveThread(
        thread && groupThreads
          ? getGroupDragPreviewThread(thread, groupThreads)
          : thread,
      );
      setDragOverParentKey(null);
      setUnchangedParentKey(null);
      setRowDrop(null);
      setReorderTarget(null);
      setReadyNestCandidate(null);
    },
    [clearDropDwell, clearNestCandidate, lookup],
  );

  const projectedNestParentId =
    rowDrop?.state === "valid" ? rowDrop.threadId : null;

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
        projectedNestParentId,
      );
      const nextRowDrop = resolveRowDropState(decision);
      const targetParentKey = resolveTargetParentKey(decision);
      const nextUnchangedParentKey = resolveUnchangedParentKey(decision);
      const nextReorderTarget = resolvePinnedReorderTarget(
        lookup,
        activeId,
        decision,
      );
      const targetKey =
        nextRowDrop !== null
          ? getRowDropTargetKey(nextRowDrop)
          : nextReorderTarget !== null
            ? `reorder:${nextReorderTarget.threadId}:${nextReorderTarget.placement}`
            : nextUnchangedParentKey !== null
              ? `unchanged:${nextUnchangedParentKey}`
              : targetParentKey;
      const retainedNestTarget = retainedNestTargetRef.current;
      if (nextRowDrop?.state !== "valid") {
        retainedNestTargetRef.current = null;
      } else if (retainedNestTarget?.threadId !== nextRowDrop.threadId) {
        const latestRowCollision = latestRowCollisionRef.current;
        retainedNestTargetRef.current =
          latestRowCollision?.threadId === nextRowDrop.threadId
            ? latestRowCollision
            : null;
      }
      if (targetKey === dwellTargetKeyRef.current) return;

      clearDropDwell();
      dwellTargetKeyRef.current = targetKey;
      armedNestThreadIdRef.current = nextRowDrop?.threadId ?? null;
      setDragOverParentKey(targetParentKey);
      setUnchangedParentKey(nextUnchangedParentKey);
      setRowDrop(nextRowDrop);
      if (isPinnedRoot(activeId)) setReorderTarget(nextReorderTarget);
      const expand = resolveDwellExpansion({
        onExpandThread,
        rowDrop: nextRowDrop,
        setCollapsedSections,
        targetParentKey,
      });
      if (!expand) return;
      dwellTimerRef.current = setTimeout(() => {
        dwellTimerRef.current = null;
        if (
          draggingThreadRef.current &&
          dwellTargetKeyRef.current === targetKey
        ) {
          expand();
        }
      }, SECTION_AUTO_EXPAND_MS);
    },
    [
      clearDropDwell,
      dragOverParentKey,
      isPinnedRoot,
      lookup,
      onExpandThread,
      projectedNestParentId,
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
    (
      decision: Extract<
        SectionThreadDropDecision,
        { kind: "move" | "nest" | "pin" }
      >,
      failureMessage: string,
    ) =>
      Promise.all(
        decision.unpinThreadIds.map((threadId) =>
          sidebarActions.setPinned(threadId, false),
        ),
      )
        .then(() =>
          Promise.allSettled(
            decision.updates.map((update) => sdk.threads.update(update)),
          ),
        )
        .then((results) => {
          const failures = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (failures.length > 0) {
            toast.error(failureMessage);
            throw new AggregateError(failures, failureMessage);
          }
          return Promise.all(
            decision.pinThreadIds.map((threadId) =>
              sidebarActions.setPinned(threadId, true),
            ),
          );
        }),
    [sdk, sidebarActions],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      draggingThreadRef.current = false;
      clearDropDwell();
      clearNestCandidate();
      const { activeId, overId } = getEventIds(event);
      if (activeId === null) {
        clearProjectedDrag();
        return;
      }

      if (overId !== null && topLevelSectionIds.has(activeId)) {
        const sectionOverId = topLevelSectionIds.has(overId)
          ? overId
          : resolveSectionThreadSectionOverId(lookup, overId);
        const nextOrder = reorderSidebarSectionOrder({
          activeId,
          overId: sectionOverId,
          order: topLevelSectionOrder,
        });
        if (nextOrder) onTopLevelSectionOrderChange(nextOrder);
        clearProjectedDrag();
        return;
      }

      const decision = resolveSectionThreadDropDecision(
        lookup,
        activeId,
        rowDrop?.state === "valid"
          ? getSidebarThreadRowDroppableId(rowDrop.threadId)
          : overId,
        dragOverParentKey,
        projectedNestParentId,
      );
      if (!decision) {
        clearProjectedDrag();
        return;
      }
      const settle = (request: Promise<unknown>) => {
        void request.catch(() => undefined).finally(clearProjectedDrag);
      };
      switch (decision.kind) {
        case "move":
        case "nest":
          settle(
            commitDropChanges(
              decision,
              `Failed to move ${describeThreadCount(decision.threadIds)}.`,
            ),
          );
          break;
        case "pin": {
          const insertRequests = reorderTarget
            ? buildPinInsertRequests(lookup, decision.threadIds, reorderTarget)
            : [];
          settle(
            commitDropChanges(
              decision,
              `Failed to pin ${describeThreadCount(decision.threadIds)}.`,
            ).then(() => {
              void insertPinnedThreads(insertRequests, onReorderPinnedThread);
            }),
          );
          break;
        }
        case "reorder-pinned": {
          const request =
            pinnedReorderPending || lookup.pinnedThreadIds.length < 2
              ? null
              : buildNeighborReorderRequest({
                  activeId,
                  overId: decision.overId,
                  items: lookup.pinnedThreadIds.map((id) => ({ id })),
                });
          if (request) onReorderPinnedThread(request, { onSettled: () => {} });
          clearProjectedDrag();
          return;
        }
        case "rejected":
        case "unchanged":
          clearProjectedDrag();
          return;
      }
      setPendingDropDecision(decision);
    },
    [
      clearDropDwell,
      clearNestCandidate,
      clearProjectedDrag,
      commitDropChanges,
      dragOverParentKey,
      lookup,
      onReorderPinnedThread,
      onTopLevelSectionOrderChange,
      pinnedReorderPending,
      projectedNestParentId,
      reorderTarget,
      rowDrop,
      topLevelSectionIds,
      topLevelSectionOrder,
    ],
  );

  const handleDragCancel = useCallback(() => {
    draggingThreadRef.current = false;
    clearDropDwell();
    clearProjectedDrag();
  }, [clearDropDwell, clearProjectedDrag]);

  const { consumeClickSuppression, dndContextProps, onClickCapture } =
    useSidebarReorderDnd({
      collisionDetection,
      measuring: SECTION_THREAD_DROPPABLE_MEASURING,
      onDragEnd: handleDragEnd,
      onDragStart: handleDragStart,
      onDragMove: handleDragMove,
      onDragOver: handleDragOver,
      onDragCancel: handleDragCancel,
    });

  const dropDecisionLanded =
    pendingDropDecision !== null &&
    hasDropDecisionLanded(lookup, pendingDropDecision);
  return {
    activeItemId: dropDecisionLanded ? null : activeIdRef.current,
    activeThread: dropDecisionLanded ? null : activeThread,
    consumeClickSuppression,
    dndContextProps,
    itemIdsByParentKey: lookup.itemIdsByParentKey,
    onClickCapture,
    dragOverParentKey:
      dropDecisionLanded || reorderTarget !== null ? null : dragOverParentKey,
    unchangedParentKey:
      dropDecisionLanded || reorderTarget !== null ? null : unchangedParentKey,
    nestTarget: dropDecisionLanded ? null : rowDrop,
    nestPreviewBeforeKey: null,
    reorderTarget: dropDecisionLanded ? null : reorderTarget,
    pinnedItemIds:
      lookup.itemIdsByParentKey.get(PINNED_THREAD_PARENT_KEY) ?? [],
    pinnedReorderPending,
  };
}

interface UseNestDropPreviewArgs {
  compareThreads: ThreadComparator;
  draftThreadIds: ReadonlySet<string>;
  pinnedRootNodes: readonly ThreadNode[];
  sectionDnd: SectionThreadDndState;
  sections: readonly SidebarSectionDefinition[];
  threads: readonly SidebarThread[];
}

export function useNestDropPreview({
  compareThreads,
  draftThreadIds,
  pinnedRootNodes,
  sectionDnd,
  sections,
  threads,
}: UseNestDropPreviewArgs): SectionThreadDndState {
  const groupThreadsByEnvironment = useAtomValue(
    sidebarGroupThreadsByEnvironmentAtom,
  );
  const { activeThread, nestTarget } = sectionDnd;
  if (!activeThread || nestTarget?.state !== "valid") return sectionDnd;
  return {
    ...sectionDnd,
    nestPreviewBeforeKey: resolveSidebarNestPreviewBeforeKey({
      activeThread,
      compareThreads,
      draftThreadIds,
      groupThreadsByEnvironment,
      parentThreadId: nestTarget.threadId,
      pinnedRootNodes,
      sections,
      threads,
    }),
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
  parentKey: string,
): SidebarSectionDropState | null {
  const sectionDnd = useSectionThreadDndState();
  if (!sectionDnd.activeThread) return null;
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
