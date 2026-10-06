import {
  useMemo,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  hasThreadListWorkingActivity,
  type ThreadListIndicatorState,
} from "@bb/client-core";
import {
  useSidebarSplitLayout,
  type PluginSidebarSplitPane,
} from "@bb/plugin/app";
import { cn } from "@bb/shared-ui/lib/utils";
import { Icon } from "@bb/shared-ui/icon";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import { CHROME_SECTION_LABEL_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { COARSE_POINTER_ROW_ACTION_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import type { ConsumeDragClickSuppression } from "@bb/shared-ui/hooks/use-drag-click-suppression";
import {
  SIDEBAR_CONTROL_STATE_CLASS,
  SIDEBAR_GROUP_TEXT_CLASS,
  SIDEBAR_HOVER_ACTIONS_CLASS,
  SIDEBAR_HOVER_ACTIONS_FADE_CLASS,
  SIDEBAR_HOVER_ACTIONS_GAP_CLASS,
  SIDEBAR_HOVER_ACTIONS_MOBILE_ALWAYS_VALUE,
  SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
  SIDEBAR_STANDARD_ROW_PADDING_CLASS,
} from "@bb/shared-ui/sidebar-row-classes";
import type { SidebarSortableDragBindings } from "@bb/shared-ui/sortable-motion";
import { SplitPaneMiniMap } from "@bb/shared-ui/split-pane-mini-map";
import { ThreadStatusGlyph } from "@bb/shared-ui/thread-status-glyph";
import {
  SectionDropTargetOverlay,
  useSectionDropTargetState,
} from "../dnd/useSectionThreadDnd.js";
import { SidebarStickyGroup, SidebarStickyTier } from "../ui/sidebar.js";

function stopPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

function useCollapsedSplitMiniMap(
  threads: readonly { id: string }[],
  enabled: boolean,
): PluginSidebarSplitPane[] | null {
  const layout = useSidebarSplitLayout();
  return useMemo(() => {
    if (!enabled || threads.length === 0 || layout === null) return null;
    const threadIds = new Set(threads.map((thread) => thread.id));
    const slots = layout.panes.map<PluginSidebarSplitPane>((pane) => ({
      paneId: pane.paneId,
      rect: pane.rect,
      isMe: pane.threadId !== null && threadIds.has(pane.threadId),
      isFocused: pane.isFocused,
    }));
    return slots.some((slot) => slot.isMe) ? slots : null;
  }, [enabled, layout, threads]);
}

interface TopLevelSidebarSectionProps {
  label: string;
  labelEditor?: ReactNode;
  onRename?: () => void;
  children: ReactNode;
  dropParentKey: string;
  sectionId?: string;
  stickyHeader?: boolean;
  actions: ReactNode;
  actionsOpen: boolean;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  collapsedActivity: ThreadListIndicatorState;
  collapsedThreads: readonly { id: string }[];
  dragBindings?: SidebarSortableDragBindings;
  sectionRef?: (element: HTMLDivElement | null) => void;
  sectionStyle?: CSSProperties;
  consumeClickSuppression?: ConsumeDragClickSuppression;
  isDropTargetActive?: boolean;
}

export function TopLevelSidebarSection({
  label,
  labelEditor,
  onRename,
  children,
  dropParentKey,
  sectionId,
  stickyHeader = true,
  actions,
  actionsOpen,
  isCollapsed,
  onToggleCollapsed,
  collapsedActivity,
  collapsedThreads,
  dragBindings,
  sectionRef,
  sectionStyle,
  consumeClickSuppression,
  isDropTargetActive = false,
}: TopLevelSidebarSectionProps) {
  const threadDropState = useSectionDropTargetState(dropParentKey);
  const miniMap = useCollapsedSplitMiniMap(collapsedThreads, isCollapsed);

  return (
    <SidebarStickyGroup
      ref={sectionRef}
      style={sectionStyle}
      data-sidebar-section-id={sectionId}
      data-sidebar-drop-target={threadDropState ?? undefined}
      data-sidebar-rename-row=""
      data-sidebar-sticky-header={stickyHeader ? undefined : "false"}
      className={cn(
        "group/sidebar-section relative min-w-0 rounded-md transition-colors",
        isDropTargetActive && "bg-sidebar-accent/60",
      )}
      onClickCapture={(event: MouseEvent<HTMLDivElement>) => {
        if (labelEditor || !consumeClickSuppression?.()) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {threadDropState ? (
        <SectionDropTargetOverlay state={threadDropState} />
      ) : null}
      <SidebarStickyTier
        ref={dragBindings?.setActivatorNodeRef}
        tier="label"
        className={cn(
          SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
          CHROME_SECTION_LABEL_CLASS,
          SIDEBAR_GROUP_TEXT_CLASS,
          SIDEBAR_STANDARD_ROW_PADDING_CLASS,
          "rounded-md pr-0 transition-colors",
          !stickyHeader && "relative top-auto",
          dragBindings && !dragBindings.disabled && "select-none",
        )}
        {...dragBindings?.attributes}
        {...(dragBindings?.listeners ?? {})}
      >
        <span className="relative z-10 flex min-w-0 flex-1 items-center gap-1 text-left">
          {labelEditor ?? (
            <span
              className="min-w-0 truncate"
              title={label}
              onDoubleClick={
                onRename
                  ? (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onRename();
                    }
                  : undefined
              }
            >
              {label}
            </span>
          )}
          <button
            type="button"
            disabled={Boolean(labelEditor)}
            data-sidebar-rename-anchor=""
            aria-expanded={!isCollapsed}
            data-sidebar-hover-actions-mobile={
              SIDEBAR_HOVER_ACTIONS_MOBILE_ALWAYS_VALUE
            }
            aria-label={
              isCollapsed
                ? `Expand ${label} section`
                : `Collapse ${label} section`
            }
            className={cn(
              !isCollapsed && SIDEBAR_HOVER_ACTIONS_CLASS,
              "relative z-20 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none ring-sidebar-ring focus-visible:ring-2",
              SIDEBAR_CONTROL_STATE_CLASS,
              LIST_HOVER_TRANSITION,
              labelEditor && "hidden",
            )}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggleCollapsed();
            }}
            onPointerDown={stopPropagation}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.stopPropagation();
              }
            }}
          >
            <Icon
              name="ChevronRight"
              className={cn(
                "size-3 transition-transform duration-150",
                !isCollapsed && "rotate-90",
              )}
              aria-hidden="true"
            />
          </button>
        </span>
        <span
          data-sidebar-trailing-controls=""
          className={cn(
            "relative z-20 inline-flex h-7 shrink-0 items-center max-md:pointer-coarse:h-9",
            labelEditor && "hidden",
            SIDEBAR_HOVER_ACTIONS_GAP_CLASS,
          )}
          onClick={stopPropagation}
        >
          {isCollapsed ? (
            <span
              data-sidebar-collapsed-activity-edge=""
              data-sidebar-hover-actions-open={actionsOpen ? "true" : undefined}
              className={cn(
                "pointer-events-none absolute right-0 top-1/2 z-20 inline-flex -translate-y-1/2 items-center justify-center text-subtle-foreground max-md:static max-md:shrink-0 max-md:translate-y-0",
                COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
                SIDEBAR_HOVER_ACTIONS_FADE_CLASS,
              )}
            >
              {miniMap ? (
                <SplitPaneMiniMap
                  slots={miniMap}
                  label={`${label} — contains a thread open in split`}
                  isWorking={hasThreadListWorkingActivity(collapsedActivity)}
                />
              ) : (
                <ThreadStatusGlyph {...collapsedActivity} />
              )}
            </span>
          ) : null}
          <span
            data-sidebar-hover-actions-open={actionsOpen ? "true" : undefined}
            data-sidebar-hover-actions-mobile={
              SIDEBAR_HOVER_ACTIONS_MOBILE_ALWAYS_VALUE
            }
            className={cn(
              "inline-flex shrink-0 items-center",
              SIDEBAR_HOVER_ACTIONS_GAP_CLASS,
              SIDEBAR_HOVER_ACTIONS_CLASS,
              isCollapsed && "max-md:pointer-coarse:hidden",
            )}
          >
            {actions}
          </span>
        </span>
      </SidebarStickyTier>
      {isCollapsed ? null : <div className="mt-1">{children}</div>}
    </SidebarStickyGroup>
  );
}
