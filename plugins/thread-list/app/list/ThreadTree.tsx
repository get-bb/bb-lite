import {
  createContext,
  memo,
  useCallback,
  useContext,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useAtom, useAtomValue } from "jotai";
import { DragOverlay, useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { createPortal } from "react-dom";
import {
  buildSidebarEntitySectionId,
  type SidebarSectionDefinition,
  type SidebarSectionId,
} from "@bb/client-core";
import { useSdk } from "@bb/plugin/app";
import type { ConsumeDragClickSuppression } from "@bb/shared-ui/hooks/use-drag-click-suppression";
import { cn } from "@bb/shared-ui/lib/utils";
import { getSidebarThreadGroupLineLeft } from "@bb/shared-ui/sidebar-row-classes";
import {
  useSidebarSortable,
  type SidebarSortableDragBindings,
} from "@bb/shared-ui/sortable-motion";
import {
  SidebarThreadDragChip,
  useSidebarThreadDragOverlayModifiers,
} from "../dnd/sidebarThreadDragChip.js";
import { PINNED_THREAD_PARENT_KEY } from "../dnd/dropDecision.js";
import { useSectionThreadDndState } from "../dnd/useSectionThreadDnd.js";
import {
  collectThreadNavigationEntries,
  countThreadNodeRows,
  threadNodeContains,
  type SectionGroup,
  type SidebarThread,
  type ThreadNode,
} from "../model/thread-tree.js";
import {
  resolveSectionName,
  sectionNameOverridesAtom,
} from "../model/use-sidebar-data.js";
import { sidebarCollapsedThreadSectionsAtom } from "../preferences.js";
import {
  useSidebarRename,
  useSidebarRenameState,
} from "../rows/SidebarInlineRename.js";
import { REORDER_PLACEMENT_CLASS, ThreadRow } from "../rows/ThreadRow.js";
import { SidebarStickyGroup } from "../ui/sidebar.js";
import {
  SidebarHeaderControls,
  SidebarSectionMenuItems,
} from "./SidebarHeaderControls.js";
import { SidebarWindowedItems } from "./SidebarWindowedItems.js";
import { TopLevelSidebarSection } from "./TopLevelSidebarSection.js";

const SIDEBAR_STICKY_PARENT_DEPTH_CAP = 4;

interface ThreadTreeContextValue {
  selectedThreadId?: string;
  collapsedThreadIds: ReadonlySet<string>;
  onToggleThreadCollapsed: (threadId: string) => void;
}

const ThreadTreeContext = createContext<ThreadTreeContextValue>({
  collapsedThreadIds: new Set(),
  onToggleThreadCollapsed: () => {},
});

export const ThreadTreeProvider = ThreadTreeContext.Provider;

function useWindowedThreadNodes(nodes: readonly ThreadNode[]) {
  const { collapsedThreadIds, selectedThreadId } =
    useContext(ThreadTreeContext);
  const rename = useSidebarRenameState();
  const renamingThreadId = rename?.kind === "thread" ? rename.id : undefined;
  const itemKeys = useMemo(
    () => nodes.map((node) => `thread:${node.thread.id}`),
    [nodes],
  );
  const estimateRows = useCallback(
    (index: number) => {
      const node = nodes[index];
      return node ? countThreadNodeRows(node, collapsedThreadIds) : 1;
    },
    [collapsedThreadIds, nodes],
  );
  const getNavigationEntries = useCallback(
    (index: number) => {
      const node = nodes[index];
      return node
        ? collectThreadNavigationEntries([node], collapsedThreadIds)
        : [];
    },
    [collapsedThreadIds, nodes],
  );
  const alwaysMountedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const node of nodes) {
      if (
        (selectedThreadId && threadNodeContains(node, selectedThreadId)) ||
        (renamingThreadId && threadNodeContains(node, renamingThreadId))
      ) {
        keys.add(`thread:${node.thread.id}`);
      }
    }
    return keys.size > 0 ? keys : undefined;
  }, [nodes, renamingThreadId, selectedThreadId]);
  return { itemKeys, estimateRows, getNavigationEntries, alwaysMountedKeys };
}

function ThreadNodeList({
  nodes,
  parentProjectId,
}: {
  nodes: readonly ThreadNode[];
  parentProjectId: string | null;
}) {
  const windowed = useWindowedThreadNodes(nodes);
  return (
    <SidebarWindowedItems
      {...windowed}
      renderItem={(index) => {
        const node = nodes[index];
        return node ? (
          <DraggableThreadNodeRow
            key={node.thread.id}
            node={node}
            parentProjectId={parentProjectId}
          />
        ) : null;
      }}
    />
  );
}

interface ThreadNodeRowProps {
  node: ThreadNode;
  parentProjectId: string | null;
  consumeClickSuppression?: ConsumeDragClickSuppression;
  dragBindings: SidebarSortableDragBindings;
  sortableRef: (element: HTMLDivElement | null) => void;
  sortableStyle: CSSProperties;
}

const ThreadNodeRow = memo(function ThreadNodeRow({
  node,
  parentProjectId,
  consumeClickSuppression,
  dragBindings,
  sortableRef,
  sortableStyle,
}: ThreadNodeRowProps) {
  const { collapsedThreadIds, onToggleThreadCollapsed, selectedThreadId } =
    useContext(ThreadTreeContext);
  const { reorderTarget } = useSectionThreadDndState();
  const { thread, depth } = node;
  const isCollapsed = collapsedThreadIds.has(thread.id);
  const hasChildren = node.children.length > 0;
  const showChildren = !isCollapsed && hasChildren;
  const reorderPlacement =
    reorderTarget?.threadId === thread.id ? reorderTarget.placement : null;
  const afterSubtree = showChildren && reorderPlacement === "after";
  const parent = useMemo(
    () =>
      hasChildren
        ? {
            isCollapsed,
            childActivity: node.childActivity,
            ...(depth < SIDEBAR_STICKY_PARENT_DEPTH_CAP
              ? { stickyLevel: depth }
              : {}),
            onToggleCollapsed: onToggleThreadCollapsed,
          }
        : null,
    [depth, hasChildren, isCollapsed, node, onToggleThreadCollapsed],
  );

  return (
    <SidebarStickyGroup
      style={sortableStyle}
      className={cn(
        "relative space-y-0.5",
        afterSubtree && REORDER_PLACEMENT_CLASS.after,
      )}
    >
      <ThreadRow
        thread={thread}
        crossProjectId={
          parentProjectId !== null && parentProjectId !== thread.projectId
            ? thread.projectId
            : null
        }
        isActive={selectedThreadId === thread.id}
        depth={depth}
        parent={parent}
        consumeClickSuppression={consumeClickSuppression}
        dragBindings={dragBindings}
        rowRef={sortableRef}
        reorderPlacement={afterSubtree ? null : reorderPlacement}
      />
      {showChildren ? (
        <div className="relative space-y-px">
          <span
            className="pointer-events-none absolute bottom-0 top-0 z-30 w-px bg-border-hairline opacity-70"
            style={{ left: getSidebarThreadGroupLineLeft(depth) }}
            aria-hidden="true"
          />
          <ThreadNodeList
            nodes={node.children}
            parentProjectId={thread.projectId}
          />
        </div>
      ) : null}
    </SidebarStickyGroup>
  );
});

const DraggableThreadNodeRow = memo(function DraggableThreadNodeRow({
  node,
  parentProjectId,
  pinnedRoot = false,
}: {
  node: ThreadNode;
  parentProjectId: string | null;
  pinnedRoot?: boolean;
}) {
  const sectionDnd = useSectionThreadDndState();
  const { dragBindings, setNodeRef, style } = useSidebarSortable({
    id: node.thread.id,
    disabled: pinnedRoot && sectionDnd.pinnedReorderPending,
    displace: false,
  });
  return (
    <ThreadNodeRow
      node={node}
      parentProjectId={parentProjectId}
      consumeClickSuppression={
        pinnedRoot ? undefined : sectionDnd.consumeClickSuppression
      }
      dragBindings={dragBindings}
      sortableRef={setNodeRef}
      sortableStyle={
        sectionDnd.activeItemId === node.thread.id
          ? { ...style, opacity: 0.35, pointerEvents: "none" }
          : style
      }
    />
  );
});

function ThreadTreeGroup({ children }: { children: ReactNode }) {
  const { onClickCapture } = useSectionThreadDndState();
  return (
    <div
      data-sidebar-sticky-section=""
      className="relative space-y-0.5"
      onClickCapture={onClickCapture}
    >
      {children}
    </div>
  );
}

export function LooseThreadTree({ nodes }: { nodes: readonly ThreadNode[] }) {
  return (
    <SortableContext
      items={nodes.map((node) => node.thread.id)}
      strategy={verticalListSortingStrategy}
    >
      <ThreadTreeGroup>
        <ThreadNodeList nodes={nodes} parentProjectId={null} />
      </ThreadTreeGroup>
    </SortableContext>
  );
}

export const PinnedThreadTree = memo(function PinnedThreadTree({
  rootNodes,
}: {
  rootNodes: readonly ThreadNode[];
}) {
  const { onClickCapture, pinnedItemIds } = useSectionThreadDndState();
  const { setNodeRef } = useDroppable({ id: PINNED_THREAD_PARENT_KEY });
  const orderedNodes = useMemo(() => {
    const nodesById = new Map(rootNodes.map((node) => [node.thread.id, node]));
    const ordered = pinnedItemIds.flatMap((id) => nodesById.get(id) ?? []);
    return ordered.length === pinnedItemIds.length ? ordered : rootNodes;
  }, [pinnedItemIds, rootNodes]);

  if (rootNodes.length === 0) return null;
  return (
    <div
      ref={setNodeRef}
      data-sidebar-sticky-section=""
      className="relative space-y-0.5"
      onClickCapture={onClickCapture}
    >
      <SortableContext
        items={[...pinnedItemIds]}
        strategy={verticalListSortingStrategy}
      >
        {orderedNodes.map((node) => (
          <DraggableThreadNodeRow
            key={node.thread.id}
            node={node}
            parentProjectId={null}
            pinnedRoot
          />
        ))}
      </SortableContext>
    </div>
  );
});

export function SectionThreadDragOverlayPortal({
  activeThread,
}: {
  activeThread: SidebarThread | null;
}) {
  const modifiers = useSidebarThreadDragOverlayModifiers();
  return createPortal(
    <DragOverlay
      className="cursor-grabbing"
      dropAnimation={null}
      modifiers={modifiers}
    >
      {activeThread ? (
        <SidebarThreadDragChip title={activeThread.displayTitle} />
      ) : null}
    </DragOverlay>,
    document.body,
  );
}

interface SectionRowProps {
  section: SectionGroup;
  onCreateThreadInSection: (sectionId: string) => void;
  onRemoveSection: (section: SidebarSectionDefinition) => void;
}

interface SectionRowContentProps extends SectionRowProps {
  sectionId: SidebarSectionId;
  consumeClickSuppression: ConsumeDragClickSuppression;
  dragBindings: SidebarSortableDragBindings;
  isDropTargetActive: boolean;
  sectionRef: (element: HTMLDivElement | null) => void;
  sectionStyle: CSSProperties;
}

const SectionRow = memo(function SectionRow(props: SectionRowProps) {
  const sectionDnd = useSectionThreadDndState();
  const sectionId = buildSidebarEntitySectionId("section", props.section.id);
  const sortable = useSidebarSortable({ id: sectionId, disabled: false });
  return (
    <SectionRowContent
      {...props}
      sectionId={sectionId}
      consumeClickSuppression={sectionDnd.consumeClickSuppression}
      dragBindings={sortable.dragBindings}
      isDropTargetActive={
        sectionDnd.activeThread === null ? sortable.isOver : false
      }
      sectionRef={sortable.setNodeRef}
      sectionStyle={sortable.style}
    />
  );
});

const SectionRowContent = memo(function SectionRowContent({
  section,
  onCreateThreadInSection,
  onRemoveSection,
  sectionId,
  consumeClickSuppression,
  dragBindings,
  isDropTargetActive,
  sectionRef,
  sectionStyle,
}: SectionRowContentProps) {
  const sdk = useSdk();
  const { itemIdsByParentKey } = useSectionThreadDndState();
  const [sectionNameOverrides, setSectionNameOverrides] = useAtom(
    sectionNameOverridesAtom,
  );
  const sectionName = resolveSectionName(
    section.id,
    section.name,
    sectionNameOverrides,
  );
  const rename = useSidebarRename({
    kind: "section",
    id: section.id,
    ownerKey: `section:${section.id}:section:0`,
    name: sectionName,
    label: "Section name",
    onSave: async (name) => {
      const previousName =
        sectionNameOverrides.get(section.id)?.previousName ?? section.name;
      setSectionNameOverrides((current) =>
        new Map(current).set(section.id, { previousName, name }),
      );
      try {
        const result = await sdk.threadSections.update({
          id: section.id,
          name,
        });
        setSectionNameOverrides((current) =>
          new Map(current).set(section.id, {
            previousName,
            name: result.name ?? name,
          }),
        );
        return result;
      } catch (error) {
        setSectionNameOverrides((current) => {
          const next = new Map(current);
          next.delete(section.id);
          return next;
        });
        throw error;
      }
    },
  });
  const [isActionsOpen, setIsActionsOpen] = useState(false);
  const [collapsedSections, setCollapsedSections] = useAtom(
    sidebarCollapsedThreadSectionsAtom,
  );
  const sectionKey = section.key;
  const isCollapsed = collapsedSections.includes(sectionKey);
  const handleToggleCollapsed = useCallback(() => {
    setCollapsedSections((current) =>
      current.includes(sectionKey)
        ? current.filter((key) => key !== sectionKey)
        : [...current, sectionKey],
    );
  }, [sectionKey, setCollapsedSections]);

  return (
    <TopLevelSidebarSection
      label={sectionName}
      labelEditor={rename.editor}
      onRename={rename.startEditing}
      sectionId={section.id}
      actions={
        <SidebarHeaderControls
          label={`${sectionName} section`}
          sectionId={sectionId}
          onNewThread={() => onCreateThreadInSection(section.id)}
          onOpenChange={setIsActionsOpen}
          onCloseAutoFocus={rename.onCloseAutoFocus}
        >
          <SidebarSectionMenuItems
            onRename={rename.startEditingFromMenu}
            onRemove={() => onRemoveSection(section)}
          />
        </SidebarHeaderControls>
      }
      actionsOpen={isActionsOpen}
      isCollapsed={isCollapsed}
      onToggleCollapsed={handleToggleCollapsed}
      collapsedActivity={section.activity}
      collapsedThreads={section.threads}
      consumeClickSuppression={consumeClickSuppression}
      dragBindings={rename.isEditing ? undefined : dragBindings}
      dropParentKey={sectionKey}
      isDropTargetActive={isDropTargetActive}
      sectionRef={sectionRef}
      sectionStyle={sectionStyle}
    >
      {section.nodes.length > 0 ? (
        <div className="relative space-y-px">
          <SortableContext
            items={[...(itemIdsByParentKey.get(sectionKey) ?? [])]}
            strategy={verticalListSortingStrategy}
          >
            <ThreadNodeList nodes={section.nodes} parentProjectId={null} />
          </SortableContext>
        </div>
      ) : null}
    </TopLevelSidebarSection>
  );
});

export function SectionTree(props: SectionRowProps) {
  const { collapsedThreadIds, selectedThreadId } =
    useContext(ThreadTreeContext);
  const collapsedSections = useAtomValue(sidebarCollapsedThreadSectionsAtom);
  const rename = useSidebarRenameState();
  const { key, id, nodes } = props.section;
  const itemKey = `section:${key}`;
  const isCollapsed = collapsedSections.includes(key);
  const isAlwaysMounted =
    nodes.some(
      (node) =>
        (selectedThreadId && threadNodeContains(node, selectedThreadId)) ||
        (rename?.kind === "thread" && threadNodeContains(node, rename.id)),
    ) ||
    (rename?.kind === "section" && rename.id === id);
  return (
    <ThreadTreeGroup>
      <SidebarWindowedItems
        itemKeys={[itemKey]}
        estimateRows={() =>
          isCollapsed
            ? 1
            : nodes.reduce(
                (total, node) =>
                  total + countThreadNodeRows(node, collapsedThreadIds),
                1,
              )
        }
        getNavigationEntries={() =>
          isCollapsed
            ? []
            : collectThreadNavigationEntries(nodes, collapsedThreadIds)
        }
        alwaysMountedKeys={isAlwaysMounted ? new Set([itemKey]) : undefined}
        renderItem={() => <SectionRow {...props} />}
      />
    </ThreadTreeGroup>
  );
}
