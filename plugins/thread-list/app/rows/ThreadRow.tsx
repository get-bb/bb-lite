import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEventHandler,
} from "react";
import { useAtomValue } from "jotai";
import {
  hasThreadListWorkingActivity,
  type ThreadListIndicatorState,
} from "@bb/client-core";
import { AppCommandShortcutPill } from "@bb/shared-ui/app-command-shortcut-pill";
import { Icon } from "@bb/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import {
  COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS,
  COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
  COARSE_POINTER_ROW_HEIGHT_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import type { ConsumeDragClickSuppression } from "@bb/shared-ui/hooks/use-drag-click-suppression";
import { cn, useComposedRefs } from "@bb/shared-ui/lib/utils";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import {
  SIDEBAR_CONTROL_BUTTON_CLASS,
  SIDEBAR_HOVER_ACTIONS_CLASS,
  SIDEBAR_HOVER_ACTIONS_FADE_CLASS,
  SIDEBAR_HOVER_ACTIONS_INSET_CLASS,
  SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
  SIDEBAR_ROW_BASE_CLASS,
  SIDEBAR_ROW_GLYPH_SLOT_CLASS,
  SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
  SIDEBAR_ROW_OPEN_IN_SPLIT_STATE_CLASS,
  SIDEBAR_ROW_SELECTED_STATE_CLASS,
  SIDEBAR_STATUS_GLYPH_BOX_CLASS,
  getSidebarThreadGroupLineLeft,
  getSidebarThreadRowPaddingLeft,
} from "@bb/shared-ui/sidebar-row-classes";
import type { SidebarSortableDragBindings } from "@bb/shared-ui/sortable-motion";
import { SplitPaneMiniMap } from "@bb/shared-ui/split-pane-mini-map";
import {
  ThreadStatusGlyph,
  resolveThreadStatus,
} from "@bb/shared-ui/thread-status-glyph";
import {
  useSidebarThreadActions,
  useSidebarThreadSplit,
  useProviders,
  ProviderIcon,
  ThreadTitle,
  ThreadViewers,
  useSidebarSplitLayout,
  useSidebarThreadDraft,
  useSidebarThreadShortcut,
  type PluginSidebarSplitPane,
} from "@bb/plugin/app";
import type {
  SidebarNestTargetState,
  SidebarReorderPlacement,
  ThreadRowNestDrop,
} from "../dnd/dropDecision.js";
import { SidebarThreadDragChip } from "../dnd/sidebarThreadDragChip.js";
import {
  mergeThreadActivity,
  threadIndicatorState,
} from "../model/thread-activity.js";
import type { SidebarThread } from "../model/thread-tree.js";
import { useSidebarProjectName } from "../model/use-sidebar-data.js";
import { sidebarShowProviderIconsAtom } from "../preferences.js";
import { SidebarStickyTier } from "../ui/sidebar.js";
import { SidebarChildToggleChevron } from "./SidebarChildToggleChevron.js";
import { useSidebarRename } from "@bb/shared-ui/sidebar-inline-rename";
import { SidebarRowControls } from "./SidebarRowControls.js";
import {
  ThreadActionsContextMenu,
  ThreadActionsMenu,
  ThreadArchiveQuickAction,
} from "./ThreadActionsMenu.js";

const SIDEBAR_TITLE_DOUBLE_CLICK_MS = 400;

let lastSidebarTitleClick: { at: number; threadId: string } | null = null;

function consumeSidebarTitleDoubleClick(threadId: string): boolean {
  const now = Date.now();
  const previous = lastSidebarTitleClick;
  lastSidebarTitleClick = { at: now, threadId };
  return (
    previous !== null &&
    previous.threadId === threadId &&
    now - previous.at < SIDEBAR_TITLE_DOUBLE_CLICK_MS
  );
}

interface ThreadRowParentOptions {
  isCollapsed: boolean;
  childActivity: ThreadListIndicatorState;
  stickyLevel?: number;
  onToggleCollapsed: (threadId: string) => void;
}

interface ThreadRowProps {
  thread: SidebarThread;
  crossProjectId: string | null;
  isActive: boolean;
  onProjectSelect?: () => void;
  depth: number;
  isCompact: boolean;
  parent: ThreadRowParentOptions | null;
  consumeClickSuppression?: ConsumeDragClickSuppression;
  dragBindings?: SidebarSortableDragBindings;
  nestDrop: ThreadRowNestDrop;
}

const NEST_TARGET_STATE_CLASS: Record<SidebarNestTargetState, string> = {
  valid:
    "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-inset ring-sidebar-ring",
  blocked: "ring-1 ring-inset ring-destructive/60",
  unchanged: "ring-1 ring-inset ring-sidebar-border",
};

export const REORDER_PLACEMENT_CLASS: Record<SidebarReorderPlacement, string> =
  {
    before:
      "before:pointer-events-none before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded-full before:bg-sidebar-ring before:content-['']",
    after:
      "after:pointer-events-none after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full after:bg-sidebar-ring after:content-['']",
  };

const HOVER_ACTIONS_INSET_STYLE = {
  "--bb-sidebar-hover-actions-inset": "calc(var(--spacing) * 7.5)",
} as CSSProperties;

function useThreadSplitMiniMap(
  threadId: string,
): readonly PluginSidebarSplitPane[] | null {
  const layout = useSidebarSplitLayout();
  return useMemo(() => {
    if (layout === null) return null;
    const slots = layout.panes.map<PluginSidebarSplitPane>((pane) => ({
      paneId: pane.paneId,
      rect: pane.rect,
      isMe: pane.threadId === threadId,
      isFocused: pane.isFocused,
    }));
    return slots.some((slot) => slot.isMe) ? slots : null;
  }, [layout, threadId]);
}

function ThreadRowComponent({
  thread,
  crossProjectId,
  isActive,
  onProjectSelect,
  depth,
  isCompact,
  parent,
  consumeClickSuppression,
  dragBindings,
  nestDrop,
}: ThreadRowProps) {
  const [isDropdownActionsOpen, setIsDropdownActionsOpen] = useState(false);
  const [isContextActionsOpen, setIsContextActionsOpen] = useState(false);
  const actions = useSidebarThreadActions();
  const showProviderIcons = useAtomValue(sidebarShowProviderIconsAtom);
  const { providers } = useProviders();
  const provider = showProviderIcons
    ? providers.find((candidate) => candidate.id === thread.providerId)
    : undefined;
  const shortcut = useSidebarThreadShortcut(thread.id);
  const { hasUnsubmittedDraft: hasComposerDraft } = useSidebarThreadDraft(
    thread.id,
  );
  const labelTitle = thread.displayTitle;
  const crossProjectName = useSidebarProjectName(crossProjectId);
  const crossProjectLabel =
    crossProjectId === null
      ? null
      : crossProjectName
        ? `In project ${crossProjectName}`
        : "In another project";
  const handleRename = useCallback(
    (nextTitle: string) => actions.rename(thread.id, nextTitle),
    [actions, thread.id],
  );
  const rename = useSidebarRename({
    kind: "thread",
    id: thread.id,
    name: labelTitle,
    label: "Thread name",
    onSave: handleRename,
  });
  const { editor, isEditing, startEditing } = rename;
  const startTitleEditing = useCallback(
    (event: { preventDefault: () => void; stopPropagation: () => void }) => {
      event.preventDefault();
      event.stopPropagation();
      startEditing();
    },
    [startEditing],
  );
  const miniMap = useThreadSplitMiniMap(thread.id);
  const split = useSidebarThreadSplit(thread.id);
  const splitAvailable = split.isAvailable;
  const openInSplit = useCallback(() => {
    actions.open(thread.id, { split: true });
  }, [actions, thread.id]);
  const hasHiddenChildren = parent?.isCollapsed ?? false;
  const threadStatus = threadIndicatorState(thread, hasComposerDraft);
  const trailingIndicatorState =
    parent && hasHiddenChildren
      ? mergeThreadActivity(threadStatus, parent.childActivity)
      : threadStatus;
  const trailingIndicator = resolveThreadStatus(trailingIndicatorState);
  const linkLabel = hasComposerDraft
    ? `Open ${labelTitle} (unsubmitted draft)`
    : `Open ${labelTitle}`;
  const rowDragBindings = isEditing ? undefined : dragBindings;
  const nestTargetState = nestDrop.state;
  const reorderPlacement = nestDrop.reorderPlacement;
  const containerRef = useComposedRefs<HTMLDivElement>(
    rowDragBindings?.setActivatorNodeRef,
    nestDrop.setNodeRef,
  );
  const isActionsOpen = isDropdownActionsOpen || isContextActionsOpen;
  const handleRowClickCapture = useCallback<MouseEventHandler<HTMLDivElement>>(
    (event) => {
      if (!consumeClickSuppression?.()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [consumeClickSuppression],
  );

  const rowLinkRef = useRef<HTMLAnchorElement>(null);
  const handleRowClick = useCallback<MouseEventHandler<HTMLDivElement>>(
    (event) => {
      if (event.target !== event.currentTarget) {
        if (!(event.target instanceof Element)) return;
        if (!event.target.closest("[data-sidebar-thread-trailing]")) return;
        if (event.target.closest("a, button")) return;
      }
      rowLinkRef.current?.click();
    },
    [],
  );
  const actionsMenu = (
    <ThreadActionsMenu
      thread={thread}
      triggerClassName={SIDEBAR_CONTROL_BUTTON_CLASS}
      onOpenInSplit={splitAvailable ? openInSplit : undefined}
      onOpenChange={setIsDropdownActionsOpen}
      onRename={rename.startEditingFromMenu}
      onCloseAutoFocus={rename.onCloseAutoFocus}
    />
  );
  const rowContent = (
    <>
      {parent?.stickyLevel !== undefined && depth > 0 ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-0.5 top-0 z-[1] w-px bg-border-hairline opacity-70"
          style={{ left: getSidebarThreadGroupLineLeft(depth - 1) }}
        />
      ) : null}
      <span
        className={cn(
          "relative flex min-w-0 flex-1 items-center gap-1.5 self-stretch",
          !isActionsOpen &&
            "group-data-[sidebar-touch-armed=true]/thread-row:hidden",
          !shortcut &&
            !isEditing &&
            (crossProjectLabel !== null || parent
              ? "pr-(--bb-sidebar-hover-actions-inset) max-md:pointer-coarse:pr-0"
              : SIDEBAR_HOVER_ACTIONS_INSET_CLASS),
        )}
        style={HOVER_ACTIONS_INSET_STYLE}
      >
        <a
          ref={rowLinkRef}
          href={thread.href}
          draggable={false}
          data-sidebar-thread-shortcut-target=""
          data-sidebar-thread-id={thread.id}
          data-sidebar-rename-anchor=""
          onClick={(event) => {
            if (isEditing) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            if (splitAvailable && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              openInSplit();
              return;
            }
            if (consumeSidebarTitleDoubleClick(thread.id)) {
              event.preventDefault();
              event.stopPropagation();
              startEditing();
              return;
            }
            onProjectSelect?.();
          }}
          onDoubleClick={isEditing ? undefined : startTitleEditing}
          aria-label={linkLabel}
          aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
          className="absolute inset-0 rounded-md outline-none"
        />
        <span
          className={cn(
            "pointer-events-none relative flex min-w-0 items-center self-stretch",
            ((crossProjectLabel === null && !parent) || isEditing) && "flex-1",
          )}
        >
          {provider ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  data-sidebar-thread-provider={provider.id}
                  role="img"
                  aria-label={provider.displayName}
                  className="pointer-events-auto relative z-[31] flex size-4 shrink-0 items-center justify-center mr-1.5 text-muted-foreground"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    rowLinkRef.current?.click();
                  }}
                >
                  <ProviderIcon
                    providerKind="agent"
                    provider={provider}
                    className="size-4"
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">{provider.displayName}</TooltipContent>
            </Tooltip>
          ) : null}
          {isEditing ? (
            <span className="pointer-events-auto relative z-10 min-w-0 flex-1 overflow-visible">
              {editor}
            </span>
          ) : (
            <span
              className={cn(
                "bb-thread-title",
                crossProjectLabel !== null && "min-w-0 truncate",
              )}
              title={labelTitle}
              onDoubleClick={startTitleEditing}
            >
              <ThreadTitle threadId={thread.id} />
            </span>
          )}
        </span>
        {crossProjectLabel !== null ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                data-sidebar-thread-cross-project=""
                role="img"
                aria-label={crossProjectLabel}
                className="relative z-[31] flex size-5 shrink-0 items-center justify-center text-muted-foreground"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  rowLinkRef.current?.click();
                }}
              >
                <Icon name="FolderExport" className="size-3.5" aria-hidden />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">{crossProjectLabel}</TooltipContent>
          </Tooltip>
        ) : null}
        {parent ? (
          <SidebarChildToggleChevron
            disabled={isEditing}
            className={isEditing ? "hidden" : undefined}
            isCollapsed={parent.isCollapsed}
            expandLabel={`Expand ${labelTitle} threads`}
            collapseLabel={`Collapse ${labelTitle} threads`}
            onToggle={() => parent.onToggleCollapsed(thread.id)}
            revealOnHover={!parent.isCollapsed}
          />
        ) : null}
      </span>
      {rowDragBindings && !rowDragBindings.disabled && !isActionsOpen ? (
        <SidebarThreadDragChip
          title={labelTitle}
          visualOnly
          className="hidden group-data-[sidebar-touch-armed=true]/thread-row:flex"
        />
      ) : null}
      <span
        data-sidebar-thread-viewers=""
        data-sidebar-hover-actions-open={isActionsOpen ? "true" : undefined}
        className={cn(
          SIDEBAR_HOVER_ACTIONS_FADE_CLASS,
          "pointer-events-none relative flex shrink-0 items-center",
          isEditing && "hidden",
        )}
      >
        <ThreadViewers threadId={thread.id} className="mr-1" />
      </span>
      <span
        data-sidebar-thread-trailing=""
        className={cn(
          "flex shrink-0 items-center gap-0.5",
          !isActionsOpen &&
            "group-data-[sidebar-touch-armed=true]/thread-row:hidden",
          isEditing && "hidden",
        )}
      >
        {thread.archivedAt !== null ? (
          <span className="relative flex items-center max-md:pointer-coarse:hidden">
            <div
              data-sidebar-hover-actions-open={
                isActionsOpen ? "true" : undefined
              }
              className={cn(
                SIDEBAR_HOVER_ACTIONS_CLASS,
                "absolute right-full z-10 max-md:pointer-coarse:hidden",
              )}
            >
              {actionsMenu}
            </div>
            <span
              className="relative z-10 pointer-events-auto"
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <ThreadArchiveQuickAction
                thread={thread}
                className={SIDEBAR_CONTROL_BUTTON_CLASS}
              />
            </span>
          </span>
        ) : shortcut ? (
          <AppCommandShortcutPill shortcut={shortcut} />
        ) : (
          <span
            className={cn(
              "flex shrink-0 items-center justify-end max-md:pointer-coarse:pointer-events-none",
              COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS,
            )}
          >
            <span
              className={cn(
                "relative shrink-0",
                COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
              )}
            >
              <span
                data-sidebar-hover-actions-open={
                  isActionsOpen ? "true" : undefined
                }
                className={cn(
                  SIDEBAR_HOVER_ACTIONS_FADE_CLASS,
                  "absolute inset-0 flex items-center justify-center",
                )}
              >
                {miniMap || trailingIndicator.indicatorKind !== "none" ? (
                  <span
                    data-sidebar-thread-trailing-indicator=""
                    className={cn(
                      SIDEBAR_ROW_GLYPH_SLOT_CLASS,
                      SIDEBAR_STATUS_GLYPH_BOX_CLASS,
                    )}
                  >
                    {miniMap ? (
                      <SplitPaneMiniMap
                        slots={miniMap}
                        label={
                          trailingIndicator.accessibleLabel
                            ? `${labelTitle} — open in split; ${trailingIndicator.accessibleLabel}`
                            : `${labelTitle} — open in split`
                        }
                        isWorking={hasThreadListWorkingActivity(
                          trailingIndicatorState,
                        )}
                      />
                    ) : (
                      <ThreadStatusGlyph
                        {...trailingIndicatorState}
                        hideIdleDraftLabel={
                          !hasHiddenChildren &&
                          trailingIndicator.indicatorKind === "draft"
                        }
                      />
                    )}
                  </span>
                ) : null}
              </span>
              <div
                data-sidebar-hover-actions-open={
                  isActionsOpen ? "true" : undefined
                }
                className={cn(
                  SIDEBAR_HOVER_ACTIONS_CLASS,
                  "absolute inset-y-0 right-0 z-10 flex items-center justify-end max-md:pointer-coarse:hidden",
                  isEditing && "invisible pointer-events-none",
                )}
              >
                <SidebarRowControls
                  primaryAction={
                    <ThreadArchiveQuickAction
                      thread={thread}
                      className={SIDEBAR_CONTROL_BUTTON_CLASS}
                    />
                  }
                >
                  {actionsMenu}
                </SidebarRowControls>
              </div>
            </span>
          </span>
        )}
      </span>
    </>
  );

  const containerProps = {
    "data-sidebar-rename-row": "",
    className: cn(
      SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
      "group/thread-row cursor-pointer",
      SIDEBAR_ROW_BASE_CLASS,
      LIST_HOVER_TRANSITION,
      parent?.stickyLevel === undefined && "relative",
      isCompact
        ? COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS
        : COARSE_POINTER_ROW_HEIGHT_CLASS,
      isActive
        ? SIDEBAR_ROW_SELECTED_STATE_CLASS
        : SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
      !isActive && miniMap !== null && SIDEBAR_ROW_OPEN_IN_SPLIT_STATE_CLASS,
      !isActive &&
        "has-[[data-state=open]]:bg-sidebar-accent has-[[data-sidebar-rename-anchor]:focus-visible]:bg-sidebar-accent",
      rowDragBindings && !rowDragBindings.disabled && "select-none",
      !isActionsOpen && "data-[sidebar-touch-armed=true]:!bg-transparent",
      nestTargetState && NEST_TARGET_STATE_CLASS[nestTargetState],
      reorderPlacement && REORDER_PLACEMENT_CLASS[reorderPlacement],
    ),
    style: { paddingLeft: getSidebarThreadRowPaddingLeft(depth) },
    "data-sidebar-nest-target": nestTargetState ?? undefined,
    "data-sidebar-reorder-placement": reorderPlacement ?? undefined,
    ...rowDragBindings?.attributes,
    ...(rowDragBindings?.listeners ?? {}),
    onClick: isEditing ? undefined : handleRowClick,
    onClickCapture:
      !isEditing && consumeClickSuppression ? handleRowClickCapture : undefined,
  };

  return (
    <ThreadActionsContextMenu
      thread={thread}
      onOpenInSplit={splitAvailable ? openInSplit : undefined}
      onOpenChange={setIsContextActionsOpen}
      onRename={rename.startEditingFromMenu}
      onCloseAutoFocus={rename.onCloseAutoFocus}
      disabled={isEditing}
      dragging={rowDragBindings?.isDragging ?? false}
    >
      {parent?.stickyLevel !== undefined ? (
        <SidebarStickyTier
          ref={containerRef}
          tier="parent"
          level={parent.stickyLevel}
          {...containerProps}
        >
          {rowContent}
        </SidebarStickyTier>
      ) : (
        <div ref={containerRef} {...containerProps}>
          {rowContent}
        </div>
      )}
    </ThreadActionsContextMenu>
  );
}

export const ThreadRow = memo(ThreadRowComponent);
