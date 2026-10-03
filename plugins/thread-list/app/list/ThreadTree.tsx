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
import { toast } from "sonner";
import {
  buildSidebarEntitySectionId,
  type SidebarSectionDefinition,
  type SidebarSectionId,
  type ThreadListIndicatorState,
} from "@bb/client-core";
import {
  useBbNavigate,
  useEnvironmentProviders,
  useSdk,
  useSidebarThreadActions,
} from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import type { ConsumeDragClickSuppression } from "@bb/shared-ui/hooks/use-drag-click-suppression";
import { Icon } from "@bb/shared-ui/icon";
import { cn, useComposedRefs } from "@bb/shared-ui/lib/utils";
import {
  SIDEBAR_CONTROL_BUTTON_CLASS,
  SIDEBAR_CONTROL_PAIR_SIZE_CLASS,
  SIDEBAR_GROUP_TEXT_CLASS,
  SIDEBAR_HOVER_ACTIONS_CLASS,
  SIDEBAR_HOVER_ACTIONS_FADE_CLASS,
  SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
  SIDEBAR_ROW_BASE_CLASS,
  getSidebarThreadGroupLineLeft,
  getSidebarThreadRowPaddingLeft,
} from "@bb/shared-ui/sidebar-row-classes";
import {
  useSidebarSortable,
  type SidebarSortableDragBindings,
} from "@bb/shared-ui/sortable-motion";
import { ThreadStatusGlyph } from "@bb/shared-ui/thread-status-glyph";
import {
  getSidebarThreadRowDroppableId,
  PINNED_THREAD_PARENT_KEY,
  type ThreadRowNestDrop,
} from "../dnd/dropDecision.js";
import {
  SidebarThreadDragChip,
  useSidebarThreadDragOverlayModifiers,
} from "../dnd/sidebarThreadDragChip.js";
import { useSectionThreadDndState } from "../dnd/useSectionThreadDnd.js";
import {
  collectThreadNavigationEntries,
  countThreadItemRows,
  getThreadItemDndId,
  getThreadItemKey,
  threadItemContains,
  threadItemThread,
  type CollapsedTreeState,
  type EnvironmentThreadGroup,
  type SectionGroup,
  type SidebarThread,
  type ThreadItem,
  type ThreadNode,
} from "../model/thread-tree.js";
import {
  resolveSectionName,
  sectionNameOverridesAtom,
} from "../model/use-sidebar-data.js";
import { sidebarCollapsedThreadSectionsAtom } from "../preferences.js";
import { SidebarChildToggleChevron } from "../rows/SidebarChildToggleChevron.js";
import {
  useSidebarRename,
  useSidebarRenameState,
} from "@bb/shared-ui/sidebar-inline-rename";
import {
  SidebarControlButton,
  SidebarRowControls,
} from "../rows/SidebarRowControls.js";
import { REORDER_PLACEMENT_CLASS, ThreadRow } from "../rows/ThreadRow.js";
import {
  findEnvironmentDisplayProvider,
  getEnvironmentLabelIconName,
  resolveEnvironmentDisplayName,
  UNNAMED_ENVIRONMENT_LABEL,
} from "../ui/environment-workspace-display.js";
import { getMutationErrorMessage } from "../ui/mutation-errors.js";
import { SidebarStickyGroup, SidebarStickyTier } from "../ui/sidebar.js";
import {
  SidebarHeaderControls,
  SidebarSectionMenuItems,
} from "./SidebarHeaderControls.js";
import { SidebarWindowedItems } from "./SidebarWindowedItems.js";
import {
  ThreadCreationPlacementScope,
  useThreadCreationPlacement,
} from "./ThreadCreationPlacement.js";
import { TopLevelSidebarSection } from "./TopLevelSidebarSection.js";

const SIDEBAR_STICKY_PARENT_DEPTH_CAP = 4;

interface ThreadTreeContextValue extends CollapsedTreeState {
  selectedThreadId?: string;
  onToggleThreadCollapsed: (threadId: string) => void;
  onToggleEnvironmentCollapsed: (environmentId: string) => void;
}

const ThreadTreeContext = createContext<ThreadTreeContextValue>({
  collapsedThreadIds: new Set(),
  collapsedEnvironmentIds: new Set(),
  onToggleThreadCollapsed: () => {},
  onToggleEnvironmentCollapsed: () => {},
});

export const ThreadTreeProvider = ThreadTreeContext.Provider;

type ActiveRename = NonNullable<ReturnType<typeof useSidebarRenameState>>;

function itemContainsRename(item: ThreadItem, rename: ActiveRename): boolean {
  if (item.kind === "thread") {
    return (
      (rename.kind === "thread" && item.node.thread.id === rename.id) ||
      item.node.children.some((child) => itemContainsRename(child, rename))
    );
  }
  return (
    (rename.kind === "environment" && item.group.environmentId === rename.id) ||
    item.group.nodes.some((node) =>
      itemContainsRename({ kind: "thread", node }, rename),
    )
  );
}

function useWindowedThreadItems(items: readonly ThreadItem[]) {
  const tree = useContext(ThreadTreeContext);
  const { collapsedThreadIds, collapsedEnvironmentIds, selectedThreadId } =
    tree;
  const rename = useSidebarRenameState();
  const itemKeys = useMemo(() => items.map(getThreadItemKey), [items]);
  const collapsed = useMemo<CollapsedTreeState>(
    () => ({ collapsedThreadIds, collapsedEnvironmentIds }),
    [collapsedThreadIds, collapsedEnvironmentIds],
  );
  const estimateRows = useCallback(
    (index: number) => {
      const item = items[index];
      return item ? countThreadItemRows(item, collapsed) : 1;
    },
    [collapsed, items],
  );
  const getNavigationEntries = useCallback(
    (index: number) => {
      const item = items[index];
      return item ? collectThreadNavigationEntries([item], collapsed) : [];
    },
    [collapsed, items],
  );
  const alwaysMountedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const item of items) {
      if (
        (selectedThreadId && threadItemContains(item, selectedThreadId)) ||
        (rename && itemContainsRename(item, rename))
      ) {
        keys.add(getThreadItemKey(item));
      }
    }
    return keys.size > 0 ? keys : undefined;
  }, [items, selectedThreadId, rename]);
  return { itemKeys, estimateRows, getNavigationEntries, alwaysMountedKeys };
}

function ThreadTreeGroupLine({ parentRowDepth }: { parentRowDepth: number }) {
  return (
    <span
      className="pointer-events-none absolute bottom-0 top-0 z-30 w-px bg-border-hairline opacity-70"
      style={{ left: getSidebarThreadGroupLineLeft(parentRowDepth) }}
      aria-hidden="true"
    />
  );
}

interface ThreadItemRowProps {
  projectId: string;
  item: ThreadItem;
  depthOffset: number;
  isEnvGrouped?: boolean;
}

interface DragRowProps {
  consumeClickSuppression?: ConsumeDragClickSuppression;
  dragBindings: SidebarSortableDragBindings;
  sortableRef: (element: HTMLDivElement | null) => void;
  sortableStyle: CSSProperties;
}

const DraggableThreadItemRow = memo(function DraggableThreadItemRow({
  projectId,
  item,
  depthOffset,
  isEnvGrouped = false,
}: ThreadItemRowProps) {
  const sectionDnd = useSectionThreadDndState();
  const itemId = getThreadItemDndId(item);
  const { dragBindings, setNodeRef, style } = useSidebarSortable({
    id: itemId,
    disabled: false,
    displace: false,
  });
  const drag: DragRowProps = {
    consumeClickSuppression: sectionDnd.consumeClickSuppression,
    dragBindings,
    sortableRef: setNodeRef,
    sortableStyle:
      sectionDnd.activeItemId === itemId
        ? { ...style, opacity: 0.35, pointerEvents: "none" }
        : style,
  };
  return item.kind === "thread" ? (
    <ThreadNodeRow
      projectId={projectId}
      node={item.node}
      depthOffset={depthOffset}
      isEnvGrouped={isEnvGrouped}
      {...drag}
    />
  ) : (
    <EnvironmentThreadGroupRow
      projectId={projectId}
      group={item.group}
      depthOffset={depthOffset}
      {...drag}
    />
  );
});

function ThreadItemList({
  items,
  projectId,
  depthOffset,
  isEnvGrouped,
  previewBeforeKey,
  preview,
}: {
  items: readonly ThreadItem[];
  projectId: string | null;
  depthOffset: number;
  isEnvGrouped?: boolean;
  previewBeforeKey?: string | null;
  preview?: ReactNode;
}) {
  const windowed = useWindowedThreadItems(items);
  return (
    <SidebarWindowedItems
      {...windowed}
      renderItem={(index) => {
        const item = items[index];
        if (!item) return null;
        return (
          <>
            {previewBeforeKey === getThreadItemKey(item) ? preview : null}
            <DraggableThreadItemRow
              projectId={projectId ?? threadItemThread(item).projectId}
              item={item}
              depthOffset={depthOffset}
              isEnvGrouped={isEnvGrouped}
            />
          </>
        );
      }}
    />
  );
}

function NestDropPreviewRow({
  depth,
  thread,
}: {
  depth: number;
  thread: SidebarThread;
}) {
  const indent =
    getSidebarThreadRowPaddingLeft(depth) - getSidebarThreadRowPaddingLeft(0);
  return (
    <div
      aria-hidden="true"
      data-sidebar-nest-drop-preview="true"
      style={{
        paddingLeft: getSidebarThreadRowPaddingLeft(0),
        marginLeft: indent > 0 ? indent : undefined,
        width: indent > 0 ? `calc(100% - ${indent}px)` : undefined,
      }}
      className={cn(
        SIDEBAR_ROW_BASE_CLASS,
        "h-7",
        "pointer-events-none overflow-hidden text-sidebar-foreground opacity-50",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{thread.displayTitle}</span>
    </div>
  );
}

interface ThreadNodeRowProps extends DragRowProps {
  projectId: string;
  node: ThreadNode;
  depthOffset: number;
  isEnvGrouped: boolean;
}

const ThreadNodeRow = memo(function ThreadNodeRow({
  projectId,
  node,
  depthOffset,
  isEnvGrouped,
  consumeClickSuppression,
  dragBindings,
  sortableRef,
  sortableStyle,
}: ThreadNodeRowProps) {
  const { collapsedThreadIds, onToggleThreadCollapsed, selectedThreadId } =
    useContext(ThreadTreeContext);
  const sectionDnd = useSectionThreadDndState();
  const { thread } = node;
  const isCollapsed = collapsedThreadIds.has(thread.id);
  const hasChildren = node.children.length > 0;
  const { setNodeRef: setNestDropNodeRef } = useDroppable({
    id: getSidebarThreadRowDroppableId(thread.id),
  });
  const rowNodeRef = useComposedRefs<HTMLDivElement>(
    setNestDropNodeRef,
    sortableRef,
  );
  const nestTargetState =
    sectionDnd.nestTarget?.threadId === thread.id
      ? sectionDnd.nestTarget.state
      : null;
  const nestPreviewThread =
    nestTargetState === "valid" && (!hasChildren || !isCollapsed)
      ? sectionDnd.activeThread
      : null;
  const nestPreviewBeforeKey = nestPreviewThread
    ? sectionDnd.nestPreviewBeforeKey
    : null;
  const reorderPlacement =
    sectionDnd.reorderTarget?.threadId === thread.id
      ? sectionDnd.reorderTarget.placement
      : null;
  const showChildren = !isCollapsed && hasChildren;
  const afterSubtree = showChildren && reorderPlacement === "after";
  const nestDrop = useMemo<ThreadRowNestDrop>(
    () => ({
      setNodeRef: rowNodeRef,
      state: nestTargetState,
      reorderPlacement: afterSubtree ? null : reorderPlacement,
    }),
    [afterSubtree, nestTargetState, reorderPlacement, rowNodeRef],
  );
  const rowDepth = node.depth + depthOffset;
  const parent = useMemo(
    () =>
      hasChildren
        ? {
            isCollapsed,
            childActivity: node.childActivity,
            ...(rowDepth < SIDEBAR_STICKY_PARENT_DEPTH_CAP
              ? { stickyLevel: rowDepth }
              : {}),
            onToggleCollapsed: onToggleThreadCollapsed,
          }
        : null,
    [hasChildren, isCollapsed, node, onToggleThreadCollapsed, rowDepth],
  );
  const preview =
    nestPreviewThread !== null ? (
      <NestDropPreviewRow depth={rowDepth + 1} thread={nestPreviewThread} />
    ) : null;

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
          thread.projectId !== projectId ? thread.projectId : null
        }
        isActive={selectedThreadId === thread.id}
        depth={rowDepth}
        isCompact={node.depth > 0 || isEnvGrouped}
        parent={parent}
        consumeClickSuppression={consumeClickSuppression}
        dragBindings={dragBindings}
        nestDrop={nestDrop}
      />
      {showChildren || preview ? (
        <div className="relative space-y-px">
          <ThreadTreeGroupLine parentRowDepth={rowDepth} />
          {showChildren ? (
            <ThreadItemList
              items={node.children}
              projectId={thread.projectId}
              depthOffset={depthOffset}
              previewBeforeKey={nestPreviewBeforeKey}
              preview={preview}
            />
          ) : null}
          {nestPreviewBeforeKey === null ? preview : null}
        </div>
      ) : null}
    </SidebarStickyGroup>
  );
});

function formatArchivedEnvironmentThreadsToastTitle(
  archivedThreadIds: readonly string[],
  threads: readonly SidebarThread[],
): string {
  if (archivedThreadIds.length !== 1) {
    return `Archived ${archivedThreadIds.length} threads`;
  }
  const archivedThread = threads.find(
    (thread) => thread.id === archivedThreadIds[0],
  );
  return archivedThread
    ? `Archived ${archivedThread.displayTitle}`
    : "Archived 1 thread";
}

interface EnvironmentThreadGroupHeaderProps {
  dragBindings: SidebarSortableDragBindings;
  group: EnvironmentThreadGroup;
  projectId: string;
  rowDepth: number;
  stickyLevel?: number;
  parentLineDepth?: number;
  isCollapsed: boolean;
}

function EnvironmentThreadGroupHeader({
  dragBindings,
  group,
  projectId,
  rowDepth,
  stickyLevel,
  parentLineDepth,
  isCollapsed,
}: EnvironmentThreadGroupHeaderProps) {
  const { environmentId, environmentProviderId, nodes } = group;
  const representativeThread = nodes[0].thread;
  const { onToggleEnvironmentCollapsed, selectedThreadId } =
    useContext(ThreadTreeContext);
  const [isActionsOpen, setIsActionsOpen] = useState(false);
  const [archiveThreadsPending, setArchiveThreadsPending] = useState(false);
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const sidebarActions = useSidebarThreadActions();
  const sectionWhenUnpinned = nodes.every(
    (node) => node.thread.sectionId === representativeThread.sectionId,
  )
    ? representativeThread.sectionId
    : null;
  const { sectionId, pinned } = useThreadCreationPlacement(sectionWhenUnpinned);
  const environmentProviders = useEnvironmentProviders();
  const providerLookup = findEnvironmentDisplayProvider(
    environmentProviders.status === "ready"
      ? environmentProviders.providers
      : undefined,
    environmentProviderId,
  );
  const environment = {
    branchName: representativeThread.environment?.branchName ?? null,
    path: representativeThread.environment?.path ?? null,
    environmentProviderId,
  };
  const customName = representativeThread.environment?.name ?? null;
  const displayName =
    resolveEnvironmentDisplayName(
      { ...environment, name: customName },
      providerLookup,
    ) ?? UNNAMED_ENVIRONMENT_LABEL;
  const updateEnvironment = useCallback(
    (name: string | null) => sdk.environments.update({ environmentId, name }),
    [environmentId, sdk],
  );
  const rename = useSidebarRename({
    kind: "environment",
    id: environmentId,
    ownerKey: `environment:${environmentId}:${representativeThread.id}`,
    name: customName ?? "",
    label: "Environment name",
    placeholder:
      resolveEnvironmentDisplayName(
        { ...environment, name: null },
        providerLookup,
      ) ?? UNNAMED_ENVIRONMENT_LABEL,
    maxLength: 80,
    onSave: (name) => updateEnvironment(name),
    onClear: customName != null ? () => updateEnvironment(null) : undefined,
  });
  const handleArchiveThreads = () => {
    setArchiveThreadsPending(true);
    void sdk.environments
      .archiveThreads({ environmentId })
      .then((response) => {
        toast.success(
          formatArchivedEnvironmentThreadsToastTitle(
            response.archivedThreadIds,
            nodes.map((node) => node.thread),
          ),
        );
        if (
          selectedThreadId &&
          response.archivedThreadIds.includes(selectedThreadId)
        ) {
          navigate.toProject(projectId);
        }
      })
      .catch((error: unknown) => {
        toast.error(
          getMutationErrorMessage(
            error,
            "Failed to archive environment threads.",
          ),
        );
      })
      .finally(() => setArchiveThreadsPending(false));
  };
  const childActivity: ThreadListIndicatorState = group.childActivity;
  const showRollupGlyph =
    isCollapsed &&
    (childActivity.hasPendingInteraction ||
      childActivity.isRuntimeActive ||
      childActivity.isWorkflowActive ||
      childActivity.isBackgroundAgentActive ||
      childActivity.isBackgroundCommandActive ||
      childActivity.isGoalActive ||
      childActivity.hasUnsubmittedDraft ||
      childActivity.hasUnreadSuccess ||
      childActivity.hasUnreadError);
  const className = cn(
    SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
    stickyLevel === undefined && "relative",
    SIDEBAR_ROW_BASE_CLASS,
    "h-7",
  );
  const style = { paddingLeft: getSidebarThreadRowPaddingLeft(rowDepth) };
  const content = (
    <>
      {parentLineDepth === undefined ? null : (
        <span
          className="pointer-events-none absolute -bottom-0.5 top-0 z-[1] w-px bg-border-hairline opacity-70"
          style={{ left: getSidebarThreadGroupLineLeft(parentLineDepth) }}
          aria-hidden="true"
        />
      )}
      <span
        className={cn(
          "pointer-events-none relative z-10 inline-flex shrink-0 items-center justify-center",
          SIDEBAR_GROUP_TEXT_CLASS,
          "h-4 w-4",
        )}
        aria-hidden="true"
      >
        <Icon
          name={getEnvironmentLabelIconName(providerLookup)}
          className="size-4"
          aria-hidden="true"
        />
      </span>
      <span
        className={cn(
          "relative z-10 flex min-w-0 flex-1 items-center gap-1.5 text-left",
          SIDEBAR_GROUP_TEXT_CLASS,
        )}
      >
        {rename.editor ?? (
          <span
            className="min-w-0 truncate"
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              rename.startEditing();
            }}
          >
            {displayName}
          </span>
        )}
        <SidebarChildToggleChevron
          disabled={rename.isEditing}
          className={rename.isEditing ? "hidden" : undefined}
          isCollapsed={isCollapsed}
          expandLabel={`Expand ${displayName} threads`}
          collapseLabel={`Collapse ${displayName} threads`}
          onToggle={() => onToggleEnvironmentCollapsed(environmentId)}
          revealOnHover={!isCollapsed}
        />
      </span>
      <span
        className={cn(
          "relative z-10 inline-flex shrink-0 items-center",
          rename.isEditing && "hidden",
        )}
      >
        {showRollupGlyph ? (
          <span
            data-sidebar-hover-actions-open={isActionsOpen ? "true" : undefined}
            className={cn(
              SIDEBAR_HOVER_ACTIONS_FADE_CLASS,
              "h-7 w-7",
              "pointer-events-none absolute right-0 flex items-center justify-center text-subtle-foreground",
            )}
          >
            <ThreadStatusGlyph {...childActivity} />
          </span>
        ) : null}
        <div
          data-sidebar-hover-actions-open={isActionsOpen ? "true" : undefined}
          className={cn(
            SIDEBAR_HOVER_ACTIONS_CLASS,
            SIDEBAR_CONTROL_PAIR_SIZE_CLASS,
            "relative flex items-center justify-end",
            rename.isEditing && "hidden",
          )}
        >
          <SidebarRowControls
            primaryAction={
              <SidebarControlButton
                label="New thread in environment"
                icon="MessageSquarePlus"
                onClick={() =>
                  sidebarActions.openNewThread({
                    projectId,
                    environmentId,
                    placement: { sectionId, pinned },
                    focusPrompt: true,
                  })
                }
              />
            }
          >
            <DropdownMenu onOpenChange={setIsActionsOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Environment actions"
                  data-sidebar-rename-anchor=""
                  className={SIDEBAR_CONTROL_BUTTON_CLASS}
                >
                  <Icon name="MoreHorizontal" className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                onCloseAutoFocus={rename.onCloseAutoFocus}
              >
                <DropdownMenuItem
                  onSelect={() => {
                    rename.startEditingFromMenu();
                  }}
                >
                  <Icon name="Edit" aria-hidden="true" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={archiveThreadsPending}
                  onSelect={(event) => {
                    if (archiveThreadsPending) {
                      event.preventDefault();
                      return;
                    }
                    handleArchiveThreads();
                  }}
                >
                  <Icon name="Archive" aria-hidden="true" />
                  Archive
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarRowControls>
        </div>
      </span>
    </>
  );

  if (stickyLevel !== undefined) {
    return (
      <SidebarStickyTier
        {...dragBindings.attributes}
        {...dragBindings.listeners}
        ref={dragBindings.setActivatorNodeRef}
        tier="parent"
        data-sidebar-rename-row=""
        level={stickyLevel}
        className={className}
        style={style}
      >
        {content}
      </SidebarStickyTier>
    );
  }
  return (
    <div
      {...dragBindings.attributes}
      {...dragBindings.listeners}
      ref={dragBindings.setActivatorNodeRef}
      data-sidebar-rename-row=""
      className={className}
      style={style}
    >
      {content}
    </div>
  );
}

interface EnvironmentThreadGroupRowProps extends DragRowProps {
  projectId: string;
  group: EnvironmentThreadGroup;
  depthOffset: number;
}

const EnvironmentThreadGroupRow = memo(function EnvironmentThreadGroupRow({
  projectId,
  group,
  depthOffset,
  dragBindings,
  sortableRef,
  sortableStyle,
}: EnvironmentThreadGroupRowProps) {
  const { collapsedEnvironmentIds } = useContext(ThreadTreeContext);
  const isCollapsed = collapsedEnvironmentIds.has(group.environmentId);
  const nodeDepth = group.nodes[0].depth;
  const rowDepth = nodeDepth + depthOffset;
  const depthAdjustment = rowDepth > 0 ? 1 : 0;
  const groupDepth = rowDepth - depthAdjustment;
  const nodeItems = useMemo<ThreadItem[]>(
    () => group.nodes.map((node) => ({ kind: "thread", node })),
    [group.nodes],
  );

  return (
    <SidebarStickyGroup
      ref={sortableRef}
      style={sortableStyle}
      className="space-y-0.5"
    >
      <EnvironmentThreadGroupHeader
        dragBindings={dragBindings}
        group={group}
        projectId={projectId}
        rowDepth={groupDepth}
        stickyLevel={
          rowDepth < SIDEBAR_STICKY_PARENT_DEPTH_CAP ? rowDepth : undefined
        }
        parentLineDepth={nodeDepth > 0 ? rowDepth - 1 : undefined}
        isCollapsed={isCollapsed}
      />
      {!isCollapsed ? (
        <div className="relative space-y-px">
          <ThreadTreeGroupLine parentRowDepth={groupDepth} />
          <ThreadItemList
            items={nodeItems}
            projectId={projectId}
            depthOffset={depthOffset + 1 - depthAdjustment}
            isEnvGrouped
          />
        </div>
      ) : null}
    </SidebarStickyGroup>
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

export function LooseThreadTree({ items }: { items: readonly ThreadItem[] }) {
  return (
    <SortableContext
      items={items.map(getThreadItemDndId)}
      strategy={verticalListSortingStrategy}
    >
      <ThreadTreeGroup>
        <ThreadItemList items={items} projectId={null} depthOffset={0} />
      </ThreadTreeGroup>
    </SortableContext>
  );
}

const PinnedRootItem = memo(function PinnedRootItem({
  item,
}: {
  item: ThreadItem;
}) {
  const sectionDnd = useSectionThreadDndState();
  const itemId = getThreadItemDndId(item);
  const { dragBindings, setNodeRef, style } = useSidebarSortable({
    id: itemId,
    disabled: item.kind === "thread" && sectionDnd.pinnedReorderPending,
    displace: false,
  });
  const drag: DragRowProps = {
    dragBindings,
    sortableRef: setNodeRef,
    sortableStyle:
      sectionDnd.activeItemId === itemId
        ? { ...style, opacity: 0.35, pointerEvents: "none" }
        : style,
  };
  const projectId = threadItemThread(item).projectId;
  return item.kind === "thread" ? (
    <ThreadNodeRow
      projectId={projectId}
      node={item.node}
      depthOffset={0}
      isEnvGrouped={false}
      {...drag}
    />
  ) : (
    <EnvironmentThreadGroupRow
      projectId={projectId}
      group={item.group}
      depthOffset={0}
      {...drag}
    />
  );
});

export const PinnedThreadTree = memo(function PinnedThreadTree({
  rootItems,
}: {
  rootItems: readonly ThreadItem[];
}) {
  const { onClickCapture, pinnedItemIds } = useSectionThreadDndState();
  const { setNodeRef } = useDroppable({ id: PINNED_THREAD_PARENT_KEY });

  if (rootItems.length === 0) return null;
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
        {rootItems.map((item) => (
          <PinnedRootItem key={getThreadItemDndId(item)} item={item} />
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
      <ThreadCreationPlacementScope group={sectionId}>
        {section.items.length > 0 ? (
          <div className="relative space-y-px">
            <SortableContext
              items={[...(itemIdsByParentKey.get(sectionKey) ?? [])]}
              strategy={verticalListSortingStrategy}
            >
              <ThreadItemList
                items={section.items}
                projectId={null}
                depthOffset={0}
              />
            </SortableContext>
          </div>
        ) : null}
      </ThreadCreationPlacementScope>
    </TopLevelSidebarSection>
  );
});

export function SectionTree(props: SectionRowProps) {
  const tree = useContext(ThreadTreeContext);
  const collapsedSections = useAtomValue(sidebarCollapsedThreadSectionsAtom);
  const rename = useSidebarRenameState();
  const { key, id, items } = props.section;
  const itemKey = `section:${key}`;
  const isCollapsed = collapsedSections.includes(key);
  const selectedThreadId = tree.selectedThreadId;
  const isAlwaysMounted = Boolean(
    items.some(
      (item) =>
        (selectedThreadId && threadItemContains(item, selectedThreadId)) ||
        (rename && itemContainsRename(item, rename)),
    ) ||
    (rename?.kind === "section" && rename.id === id),
  );
  return (
    <ThreadTreeGroup>
      <SidebarWindowedItems
        itemKeys={[itemKey]}
        estimateRows={() =>
          isCollapsed
            ? 1
            : items.reduce(
                (total, item) => total + countThreadItemRows(item, tree),
                1,
              )
        }
        getNavigationEntries={() =>
          isCollapsed ? [] : collectThreadNavigationEntries(items, tree)
        }
        alwaysMountedKeys={isAlwaysMounted ? new Set([itemKey]) : undefined}
        renderItem={() => <SectionRow {...props} />}
      />
    </ThreadTreeGroup>
  );
}
