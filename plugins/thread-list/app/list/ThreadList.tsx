import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { DndContext, useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { toast } from "sonner";
import {
  buildSidebarEntitySectionId,
  CHRONOLOGICAL_CONTAINER_ID,
  insertSidebarSectionAfter,
  type CollapsibleSidebarSectionId,
  type SidebarSectionDefinition,
  type SidebarSectionId,
  type ThreadListIndicatorState,
} from "@bb/client-core";
import {
  useSidebarThreadActions,
  useSdk,
  useSidebarThreadDraftIds,
} from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "@bb/shared-ui/confirm-delete-dialog";
import { cn } from "@bb/shared-ui/lib/utils";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { useSidebarSortable } from "@bb/shared-ui/sortable-motion";
import { ThreadListEmptyState } from "@bb/shared-ui/thread-list-empty-state";
import { PINNED_THREAD_PARENT_KEY } from "../dnd/dropDecision.js";
import {
  SectionThreadDndProvider,
  useNestDropPreview,
  useSectionThreadDnd,
  type PinnedThreadReorderHandler,
} from "../dnd/useSectionThreadDnd.js";
import { rollupThreadActivity } from "../model/thread-activity.js";
import {
  buildPinnedThreadState,
  buildSectionThreadList,
  flattenThreadItems,
  getThreadComparator,
  type SidebarThread,
  type ThreadItem,
} from "../model/thread-tree.js";
import { useSidebarData } from "../model/use-sidebar-data.js";
import {
  collapsedEnvironmentIdsAtom,
  collapsedSidebarSectionIdsAtom,
  collapsedThreadIdsAtom,
  sidebarChronologicalSortAtom,
  sidebarGroupThreadsByEnvironmentAtom,
  sidebarManualSectionOrderAtom,
  sidebarSortDirectionAtom,
  usePreferencesReady,
} from "../preferences.js";
import {
  SidebarRenameProvider,
  useSidebarRenameState,
} from "@bb/shared-ui/sidebar-inline-rename";
import { ThreadSectionMoveProvider } from "../rows/ThreadSectionMoveProvider.js";
import {
  getErrorCode,
  getMutationErrorMessage,
} from "../ui/mutation-errors.js";
import {
  SidebarContentElementProvider,
  SidebarGroupContent,
  SidebarStickyStack,
} from "../ui/sidebar.js";
import {
  SidebarHeaderActionsProvider,
  SidebarHeaderControls,
} from "./SidebarHeaderControls.js";
import { ThreadCreationPlacementScope } from "./ThreadCreationPlacement.js";
import { ThreadSectionCreateDialog } from "./ThreadSectionCreateDialog.js";
import {
  LooseThreadTree,
  PinnedThreadTree,
  SectionThreadDragOverlayPortal,
  SectionTree,
  ThreadTreeProvider,
} from "./ThreadTree.js";
import { TopLevelSidebarSection } from "./TopLevelSidebarSection.js";
import { useSectionOrder } from "./useSectionOrder.js";

function toggleId<Id extends string>(current: readonly Id[], id: Id): Id[] {
  const next = new Set(current);
  if (!next.delete(id)) next.add(id);
  return Array.from(next);
}

function getSectionMutationErrorMessage(
  error: unknown,
  fallbackMessage: string,
): string {
  return getErrorCode(error) === "section_name_conflict"
    ? "Section name already exists."
    : getMutationErrorMessage(error, fallbackMessage);
}

function ThreadListShell({ children }: { children: ReactNode }) {
  return (
    <SidebarContentElementProvider>
      <SidebarStickyStack data-sidebar-sticky-density="compact-actions">
        <SidebarGroupContent>{children}</SidebarGroupContent>
      </SidebarStickyStack>
    </SidebarContentElementProvider>
  );
}

function ThreadListLoadingRow({ widthClassName }: { widthClassName: string }) {
  return (
    <div
      data-sidebar="navigation-loading-row"
      className="flex h-7 items-center gap-2 rounded-md"
    >
      <Skeleton className="size-4 shrink-0 rounded-md bg-sidebar-border/60" />
      <Skeleton
        className={cn("h-3 rounded-sm bg-sidebar-border/50", widthClassName)}
      />
    </div>
  );
}

interface BuiltInSectionProps {
  id: CollapsibleSidebarSectionId;
  label: string;
  disabled: boolean;
  threads: readonly SidebarThread[];
  activity: ThreadListIndicatorState;
  isCollapsed: boolean;
  isMenuOpen: boolean;
  onMenuOpenChange: (id: CollapsibleSidebarSectionId, open: boolean) => void;
  onNewThread: (id: CollapsibleSidebarSectionId) => void;
  onToggleCollapsed: (id: CollapsibleSidebarSectionId) => void;
  consumeClickSuppression: () => boolean;
  children: ReactNode;
}

const BuiltInSection = memo(function BuiltInSection({
  id,
  label,
  disabled,
  threads,
  activity,
  isCollapsed,
  isMenuOpen,
  onMenuOpenChange,
  onNewThread,
  onToggleCollapsed,
  consumeClickSuppression,
  children,
}: BuiltInSectionProps) {
  const { dragBindings, setNodeRef, style } = useSidebarSortable({
    id,
    disabled,
  });
  return (
    <TopLevelSidebarSection
      label={label}
      stickyHeader={id !== "pinned"}
      actions={
        <SidebarHeaderControls
          label={label}
          sectionId={id}
          onNewThread={() => onNewThread(id)}
          open={isMenuOpen}
          onOpenChange={(open) => onMenuOpenChange(id, open)}
        />
      }
      actionsOpen={isMenuOpen}
      collapsedActivity={activity}
      collapsedThreads={threads}
      isCollapsed={isCollapsed}
      onToggleCollapsed={() => onToggleCollapsed(id)}
      consumeClickSuppression={consumeClickSuppression}
      dropParentKey={
        id === "pinned" ? PINNED_THREAD_PARENT_KEY : CHRONOLOGICAL_CONTAINER_ID
      }
      dragBindings={dragBindings}
      sectionRef={setNodeRef}
      sectionStyle={style}
    >
      <ThreadCreationPlacementScope group={id}>
        {children}
      </ThreadCreationPlacementScope>
    </TopLevelSidebarSection>
  );
});

function LooseThreads({
  items,
  unavailable,
}: {
  items: readonly ThreadItem[];
  unavailable: boolean;
}) {
  const { setNodeRef } = useDroppable({ id: CHRONOLOGICAL_CONTAINER_ID });
  return (
    <div ref={setNodeRef}>
      {items.length > 0 ? (
        <LooseThreadTree items={items} />
      ) : (
        <ThreadListEmptyState
          message={unavailable ? "Threads unavailable" : undefined}
          className="py-0.5 px-2"
        />
      )}
    </div>
  );
}

interface ThreadSectionsProps {
  threads: readonly SidebarThread[];
  sections: readonly SidebarSectionDefinition[];
  unavailable: boolean;
  selectedThreadId?: string;
  personalProjectId: string | null;
  onRemoveSection: (section: SidebarSectionDefinition) => void;
}

function ThreadSections({
  threads,
  sections,
  unavailable,
  selectedThreadId,
  personalProjectId,
  onRemoveSection,
}: ThreadSectionsProps) {
  const sdk = useSdk();
  const sidebarActions = useSidebarThreadActions();
  const draftThreadIds = useSidebarThreadDraftIds();
  const [isPinnedReorderPending, setIsPinnedReorderPending] = useState(false);
  const handleReorderPinnedRoot = useCallback<PinnedThreadReorderHandler>(
    (request, callbacks) => {
      setIsPinnedReorderPending(true);
      void sdk.threads
        .reorderPinned({
          threadId: request.itemId,
          previousThreadId: request.previousItemId,
          nextThreadId: request.nextItemId,
        })
        .catch((error: unknown) => {
          toast.error(
            getMutationErrorMessage(error, "Failed to reorder pinned thread."),
          );
        })
        .finally(() => {
          setIsPinnedReorderPending(false);
          callbacks.onSettled();
        });
    },
    [sdk],
  );
  const openNewThread = useCallback(
    (projectId: string | null, sectionId: string | null, pinned: boolean) => {
      sidebarActions.openNewThread({
        ...(projectId !== null ? { projectId } : {}),
        placement: { sectionId, pinned },
        focusPrompt: true,
      });
    },
    [sidebarActions],
  );
  const handleNewBuiltInThread = useCallback(
    (id: CollapsibleSidebarSectionId) => {
      openNewThread(
        id === "pinned" ? null : personalProjectId,
        null,
        id === "pinned",
      );
    },
    [openNewThread, personalProjectId],
  );
  const handleNewSectionThread = useCallback(
    (sectionId: string) => openNewThread(null, sectionId, false),
    [openNewThread],
  );
  const [collapsedThreadIdList, setCollapsedThreadIdList] = useAtom(
    collapsedThreadIdsAtom,
  );
  const [collapsedEnvironmentIdList, setCollapsedEnvironmentIdList] = useAtom(
    collapsedEnvironmentIdsAtom,
  );
  const [collapsedSectionIdList, setCollapsedSectionIdList] = useAtom(
    collapsedSidebarSectionIdsAtom,
  );
  const groupThreadsByEnvironment = useAtomValue(
    sidebarGroupThreadsByEnvironmentAtom,
  );
  const [openMenu, setOpenMenu] = useState<CollapsibleSidebarSectionId | null>(
    null,
  );
  const handleMenuOpenChange = useCallback(
    (id: CollapsibleSidebarSectionId, open: boolean) => {
      setOpenMenu((current) => (open ? id : current === id ? null : current));
    },
    [],
  );
  const [chronologicalSort, setChronologicalSort] = useAtom(
    sidebarChronologicalSortAtom,
  );
  const sortDirection = useAtomValue(sidebarSortDirectionAtom);
  const activeRename = useSidebarRenameState();
  const renamingThread = useMemo(
    () =>
      activeRename?.kind === "thread"
        ? { id: activeRename.id, name: activeRename.name }
        : null,
    [activeRename],
  );
  const compareThreads = useMemo(
    () => getThreadComparator(chronologicalSort, sortDirection, renamingThread),
    [chronologicalSort, sortDirection, renamingThread],
  );
  const collapsedThreadIds = useMemo(
    () => new Set(collapsedThreadIdList),
    [collapsedThreadIdList],
  );
  const collapsedEnvironmentIds = useMemo(
    () => new Set(collapsedEnvironmentIdList),
    [collapsedEnvironmentIdList],
  );
  const collapsedSectionIds = useMemo(
    () => new Set(collapsedSectionIdList),
    [collapsedSectionIdList],
  );
  useEffect(() => {
    if (collapsedSectionIds.size !== collapsedSectionIdList.length) {
      setCollapsedSectionIdList([...collapsedSectionIds]);
    }
  }, [collapsedSectionIdList, collapsedSectionIds, setCollapsedSectionIdList]);
  useEffect(() => {
    if (chronologicalSort === "none") {
      setChronologicalSort("updated");
    }
  }, [chronologicalSort, setChronologicalSort]);
  const toggleThreadCollapsed = useCallback(
    (threadId: string) => {
      setCollapsedThreadIdList((current) => toggleId(current, threadId));
    },
    [setCollapsedThreadIdList],
  );
  const toggleEnvironmentCollapsed = useCallback(
    (environmentId: string) => {
      setCollapsedEnvironmentIdList((current) =>
        toggleId(current, environmentId),
      );
    },
    [setCollapsedEnvironmentIdList],
  );
  const expandThread = useCallback(
    (threadId: string) => {
      if (collapsedThreadIds.has(threadId)) toggleThreadCollapsed(threadId);
    },
    [collapsedThreadIds, toggleThreadCollapsed],
  );
  const toggleSectionCollapsed = useCallback(
    (sectionId: CollapsibleSidebarSectionId) => {
      setCollapsedSectionIdList((current) => toggleId(current, sectionId));
    },
    [setCollapsedSectionIdList],
  );
  const pinned = useMemo(
    () =>
      buildPinnedThreadState(
        threads,
        draftThreadIds,
        groupThreadsByEnvironment,
      ),
    [draftThreadIds, groupThreadsByEnvironment, threads],
  );
  const pinnedThreads = useMemo(
    () =>
      threads.filter(
        (thread) =>
          pinned.effectivePinnedThreadIds.has(thread.id) && !thread.isHidden,
      ),
    [pinned, threads],
  );
  const listThreads = useMemo(
    () =>
      unavailable
        ? []
        : threads.filter(
            (thread) => !pinned.effectivePinnedThreadIds.has(thread.id),
          ),
    [pinned, threads, unavailable],
  );
  const list = useMemo(
    () =>
      buildSectionThreadList(
        listThreads,
        compareThreads,
        sections,
        draftThreadIds,
        groupThreadsByEnvironment,
      ),
    [
      compareThreads,
      draftThreadIds,
      groupThreadsByEnvironment,
      listThreads,
      sections,
    ],
  );
  const looseThreads = useMemo(
    () => flattenThreadItems(list.loose),
    [list.loose],
  );
  const entitySectionIds = useMemo(
    () =>
      sections.map((section) =>
        buildSidebarEntitySectionId("section", section.id),
      ),
    [sections],
  );
  const { onOrderChange, order } = useSectionOrder(
    entitySectionIds,
    pinned.rootNodes.length > 0,
  );
  const dragState = useSectionThreadDnd({
    list,
    topLevelSectionOrder: order,
    onTopLevelSectionOrderChange: onOrderChange,
    onExpandThread: expandThread,
    pinnedReorderPending: isPinnedReorderPending,
    pinnedRootItems: pinned.rootItems,
    pinnedRootNodes: pinned.rootNodes,
    onReorderPinnedThread: handleReorderPinnedRoot,
  });
  const sectionDnd = useNestDropPreview({
    compareThreads,
    draftThreadIds,
    pinnedRootNodes: pinned.rootNodes,
    sectionDnd: dragState,
    sections,
    threads: listThreads,
  });
  const threadTree = useMemo(
    () => ({
      selectedThreadId,
      collapsedThreadIds,
      collapsedEnvironmentIds,
      onToggleThreadCollapsed: toggleThreadCollapsed,
      onToggleEnvironmentCollapsed: toggleEnvironmentCollapsed,
    }),
    [
      collapsedEnvironmentIds,
      collapsedThreadIds,
      selectedThreadId,
      toggleEnvironmentCollapsed,
      toggleThreadCollapsed,
    ],
  );
  const builtInSection = (
    id: CollapsibleSidebarSectionId,
    label: string,
    sectionThreads: readonly SidebarThread[],
    content: ReactNode,
  ) => (
    <BuiltInSection
      id={id}
      label={label}
      disabled={order.length < 2}
      threads={sectionThreads}
      activity={rollupThreadActivity(sectionThreads, draftThreadIds)}
      isCollapsed={collapsedSectionIds.has(id)}
      isMenuOpen={openMenu === id}
      onMenuOpenChange={handleMenuOpenChange}
      onNewThread={handleNewBuiltInThread}
      onToggleCollapsed={toggleSectionCollapsed}
      consumeClickSuppression={sectionDnd.consumeClickSuppression}
    >
      {content}
    </BuiltInSection>
  );
  const renderSection = (sectionId: SidebarSectionId) => {
    if (sectionId === "pinned") {
      return (
        <div key={sectionId}>
          {builtInSection(
            "pinned",
            "Pinned",
            pinnedThreads,
            <PinnedThreadTree rootItems={pinned.rootItems} />,
          )}
        </div>
      );
    }
    if (sectionId === "threads") {
      return (
        <div key={sectionId} data-sidebar-visibility-group={sectionId}>
          {builtInSection(
            "threads",
            "Threads",
            looseThreads,
            <LooseThreads items={list.loose} unavailable={unavailable} />,
          )}
        </div>
      );
    }
    const section = list.sections.find(
      (candidate) =>
        buildSidebarEntitySectionId("section", candidate.id) === sectionId,
    );
    return section ? (
      <div key={sectionId} data-sidebar-visibility-group={sectionId}>
        <SectionTree
          section={section}
          onCreateThreadInSection={handleNewSectionThread}
          onRemoveSection={onRemoveSection}
        />
      </div>
    ) : null;
  };

  return (
    <div tabIndex={-1} className="min-w-0 outline-none">
      <DndContext {...dragState.dndContextProps}>
        <SectionThreadDndProvider value={sectionDnd}>
          <ThreadTreeProvider value={threadTree}>
            <SortableContext
              items={[...order]}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-4">{order.map(renderSection)}</div>
            </SortableContext>
          </ThreadTreeProvider>
          <SectionThreadDragOverlayPortal
            activeThread={dragState.activeThread}
          />
        </SectionThreadDndProvider>
      </DndContext>
    </div>
  );
}

function ThreadListContent({
  activeThreadId,
}: {
  activeThreadId: string | null;
}) {
  const sdk = useSdk();
  const { status, sections, threads, personalProjectId, archived } =
    useSidebarData();
  const preferencesReady = usePreferencesReady();
  const [isCreateSectionPending, setIsCreateSectionPending] = useState(false);
  const [isDeleteSectionPending, setIsDeleteSectionPending] = useState(false);
  const [isSectionCreateDialogOpen, setIsSectionCreateDialogOpen] =
    useState(false);
  const [sectionCreateErrorMessage, setSectionCreateErrorMessage] = useState<
    string | null
  >(null);
  const [sectionCreateAnchorId, setSectionCreateAnchorId] =
    useState<SidebarSectionId | null>(null);
  const [sectionToDelete, setSectionToDelete] =
    useState<SidebarSectionDefinition | null>(null);
  const setManualSectionOrder = useSetAtom(sidebarManualSectionOrderAtom);
  const handleOpenCreateSectionDialog = useCallback(
    (anchorSectionId?: SidebarSectionId) => {
      setSectionCreateErrorMessage(null);
      setSectionCreateAnchorId(anchorSectionId ?? null);
      setIsSectionCreateDialogOpen(true);
    },
    [],
  );
  const handleCreateSectionDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setSectionCreateErrorMessage(null);
      setIsSectionCreateDialogOpen(false);
    }
  }, []);
  const handleCreateThreadSection = useCallback(
    (name: string) => {
      setSectionCreateErrorMessage(null);
      setIsCreateSectionPending(true);
      void sdk.threadSections
        .create({ name })
        .then((section) => {
          const anchorSectionId = sectionCreateAnchorId;
          if (anchorSectionId) {
            setManualSectionOrder(
              (current) =>
                insertSidebarSectionAfter({
                  storedOrder: current,
                  entitySectionIds: sections.map((existing) =>
                    buildSidebarEntitySectionId("section", existing.id),
                  ),
                  legacyEntityAnchor: "sections",
                  anchorSectionId,
                  sectionId: buildSidebarEntitySectionId("section", section.id),
                }) ?? current,
            );
          }
          setIsSectionCreateDialogOpen(false);
        })
        .catch((error: unknown) =>
          setSectionCreateErrorMessage(
            getSectionMutationErrorMessage(error, "Failed to create section."),
          ),
        )
        .finally(() => setIsCreateSectionPending(false));
    },
    [sdk, sectionCreateAnchorId, sections, setManualSectionOrder],
  );
  const handleConfirmRemoveThreadSection = useCallback(() => {
    if (!sectionToDelete) {
      return;
    }
    setIsDeleteSectionPending(true);
    void sdk.threadSections
      .delete({ id: sectionToDelete.id })
      .then(() => setSectionToDelete(null))
      .catch((error: unknown) => {
        toast.error(
          getSectionMutationErrorMessage(error, "Failed to remove section."),
        );
      })
      .finally(() => setIsDeleteSectionPending(false));
  }, [sdk, sectionToDelete]);
  const headerActions = useMemo(
    () => ({
      onNewSection: handleOpenCreateSectionDialog,
      isCreatingSection: isCreateSectionPending,
    }),
    [handleOpenCreateSectionDialog, isCreateSectionPending],
  );

  if (status === "loading" || !preferencesReady) {
    return (
      <ThreadListShell>
        <div
          aria-label="Loading sidebar navigation"
          className="space-y-1.5 px-2 pt-1"
        >
          <ThreadListLoadingRow widthClassName="w-2/3" />
          <ThreadListLoadingRow widthClassName="w-1/2" />
        </div>
      </ThreadListShell>
    );
  }

  return (
    <SidebarHeaderActionsProvider value={headerActions}>
      <ThreadSectionMoveProvider sections={sections}>
        <ThreadListShell>
          <ThreadSections
            threads={threads}
            sections={sections}
            unavailable={status === "error"}
            selectedThreadId={activeThreadId ?? undefined}
            personalProjectId={personalProjectId}
            onRemoveSection={setSectionToDelete}
          />
          {archived !== null && (
            <>
              {status === "ready" && archived.status !== "ready" && (
                <div role="status">
                  {archived.status === "error"
                    ? "Archived threads unavailable"
                    : "Loading archived threads…"}
                </div>
              )}
              {archived.hasNextPage && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={archived.isFetchingNextPage}
                  onClick={() => void archived.fetchNextPage()}
                  aria-label="Load more archived threads"
                >
                  {archived.isFetchingNextPage
                    ? "Loading…"
                    : archived.isFetchNextPageError
                      ? "Retry loading"
                      : "Show more"}
                </Button>
              )}
            </>
          )}
        </ThreadListShell>
      </ThreadSectionMoveProvider>
      <ThreadSectionCreateDialog
        errorMessage={sectionCreateErrorMessage}
        open={isSectionCreateDialogOpen}
        pending={isCreateSectionPending}
        onOpenChange={handleCreateSectionDialogOpenChange}
        onCreate={handleCreateThreadSection}
      />
      <ConfirmDeleteDialog
        open={sectionToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setSectionToDelete(null);
        }}
      >
        {sectionToDelete ? (
          <ConfirmDeleteDialogContent
            title="Remove section?"
            description="Threads in this section will move back to Threads."
            confirmLabel="Remove section"
            pending={isDeleteSectionPending}
            onConfirm={handleConfirmRemoveThreadSection}
            onCancel={() => setSectionToDelete(null)}
          />
        ) : null}
      </ConfirmDeleteDialog>
    </SidebarHeaderActionsProvider>
  );
}

export const ThreadList = memo(function ThreadList({
  activeThreadId,
}: {
  activeThreadId: string | null;
}) {
  return (
    <SidebarRenameProvider>
      <ThreadListContent activeThreadId={activeThreadId} />
    </SidebarRenameProvider>
  );
});
