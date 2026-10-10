import { threadView } from "@bb/plugin/app";
import { SlotMount, useSlotEntries } from "@bb/app-kit/plugins/slots";
import {
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@bb/shared-ui/button";
import { useAtomValue } from "jotai";
import { COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon } from "@bb/shared-ui/icon";
import { Pill } from "@bb/shared-ui/pill";
import {
  AppPageHeader,
  HEADER_ICON_BUTTON_CLASS,
  HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
} from "@bb/app-kit/components/layout/AppPageHeader";
import type { ThreadGitActionDialogTarget } from "../../components/dialogs/ThreadGitActionDialog";
import { cn } from "@bb/shared-ui/lib/utils";
import { useAppCommandShortcut } from "@bb/app-kit/components/commands/AppCommandProvider";
import { AppCommandShortcutHint } from "@bb/app-kit/components/commands/AppCommandShortcutHint";
import { useSidebarRename } from "@bb/shared-ui/sidebar-inline-rename";
import { useThreadActions } from "@bb/app-kit/components/thread/ThreadActionsProvider";
import { ThreadTitle } from "@bb/app-kit/components/thread/ThreadTitleMentions";
import { SecondaryPanelHostLayoutContext } from "@bb/app-kit/components/secondary-panel/SecondaryPanelHostLayoutContext";
import { RIGHT_PANEL_TOGGLE_ICON_NAME } from "@bb/app-kit/components/secondary-panel/panelToggleControlState";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { dimInactiveSplitsAtom } from "@bb/app-kit/lib/split-layout/atoms";
import {
  CONTEXT_INACTIVE_TEXT_CLASS,
  CONTEXT_SELECTION_SURFACE_CLASS,
} from "@bb/app-kit/components/ui/context-selection";
import { UserAvatarStack } from "@bb/app-kit/components/users/UserAvatar";
import { useThreadViewers } from "@bb/app-kit/lib/presence";
import { usePaneContext } from "@bb/app-kit/views/thread-detail/PaneContext";
import { PaneMaximizeButton } from "./PaneMaximizeButton";
import type { ThreadHeaderGitAction } from "./useThreadGitActions";

const UNORDERED_HEADER_ITEM = 1_000;

function ThreadHeaderItems({ threadId }: { threadId: string }) {
  const entries = useSlotEntries(threadView.header);
  const ordered = [...entries].sort(
    (left, right) =>
      (left.item.order ?? UNORDERED_HEADER_ITEM) -
      (right.item.order ?? UNORDERED_HEADER_ITEM),
  );
  return ordered.map(({ plugin, item }) => (
    <SlotMount
      key={`${plugin}/${item.id}`}
      pluginId={plugin}
      slot={threadView.header.name}
      id={item.id}
      fallback={null}
    >
      <item.view threadId={threadId} />
    </SlotMount>
  ));
}

const NARROW_SPLIT_HEADER_MAX_WIDTH = 560;

export function ThreadDetailHeader({
  actionsMenu,
  showsChildPill,
  isSecondaryPanelOpen,
  onOpenThreadGitAction,
  onToggleSecondaryPanel,
  threadHeaderGitActions,
  threadId,
  threadTitle,
  workspaceOpenButton,
}: {
  actionsMenu: (includeResponsiveActions: boolean) => ReactNode;
  showsChildPill: boolean;
  isSecondaryPanelOpen: boolean;
  onOpenThreadGitAction: (target: ThreadGitActionDialogTarget) => void;
  onToggleSecondaryPanel: () => void;
  threadHeaderGitActions: readonly ThreadHeaderGitAction[];
  threadId: string;
  threadTitle: string;
  workspaceOpenButton?: ReactNode;
}) {
  const isCompactViewport = useIsCompactViewport();
  const { renameThreadAsync } = useThreadActions();
  const { editor, isEditing, startEditing } = useSidebarRename({
    kind: "thread",
    id: threadId,
    name: threadTitle,
    label: "Thread name",
    inputClassName: "field-sizing-content",
    onSave: (nextTitle) => renameThreadAsync(threadId, nextTitle),
  });
  const dimsInactiveSplits = useAtomValue(dimInactiveSplitsAtom);
  const panelShortcut = useAppCommandShortcut("panel.toggle");
  const headerRef = useRef<HTMLElement>(null);
  const pane = usePaneContext();
  const { isFocused, isSplitPane: isSplitPaneHeader } = pane;
  const isWindowPanelOpen =
    useContext(SecondaryPanelHostLayoutContext)?.isOpen === true;
  const [paneWidth, setPaneWidth] = useState(0);
  const usesActionOverflow =
    isSplitPaneHeader &&
    paneWidth > 0 &&
    paneWidth < NARROW_SPLIT_HEADER_MAX_WIDTH;
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!isSplitPaneHeader || header === null) return;
    const measured =
      header.closest<HTMLElement>("[data-split-pane-id]") ?? header;
    const measure = () => {
      const width = measured.getBoundingClientRect().width;
      if (width > 0) setPaneWidth(width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(measured);
    return () => observer.disconnect();
  }, [isSplitPaneHeader]);
  const viewers = useThreadViewers(threadId);
  const rightPanelLabel = isSecondaryPanelOpen
    ? "Hide right panel"
    : "Show right panel";

  return (
    <AppPageHeader
      headerRef={headerRef}
      ownsWindowTopLeft={pane.ownsWindowTopLeft}
      className={isSplitPaneHeader ? "z-[21]" : undefined}
      center={
        <>
          <div
            data-pane-header-focus-tab={
              isSplitPaneHeader && isFocused ? "" : undefined
            }
            className={cn(
              "relative min-w-0",
              isSplitPaneHeader && "-my-1 -ml-2 rounded-md px-2 py-1",
              isSplitPaneHeader && isFocused && CONTEXT_SELECTION_SURFACE_CLASS,
            )}
          >
            <p
              className={cn(
                "relative min-w-0 text-sm font-normal transition-colors",
                isEditing && "overflow-visible",
                isSplitPaneHeader &&
                  !isFocused &&
                  dimsInactiveSplits &&
                  CONTEXT_INACTIVE_TEXT_CLASS,
              )}
              onDoubleClick={isEditing ? undefined : startEditing}
            >
              {isEditing ? editor : <ThreadTitle title={threadTitle} />}
            </p>
          </div>
          {showsChildPill ? (
            <Pill variant="outline" size="sm">
              child
            </Pill>
          ) : null}
          <span className="flex items-center">
            {actionsMenu(usesActionOverflow)}
          </span>
        </>
      }
      actions={
        <>
          <UserAvatarStack
            users={viewers}
            max={usesActionOverflow || isCompactViewport ? 1 : 3}
            label="Also viewing"
            tooltipSide="bottom"
            className="mr-1"
          />
          <div
            className="flex items-center gap-1"
            data-thread-header-workflow-actions=""
          >
            {usesActionOverflow
              ? null
              : [
                  workspaceOpenButton,
                  ...threadHeaderGitActions.map((action) => (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className={cn(
                        COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS,
                        "border-border/70 bg-transparent font-normal hover:bg-state-hover",
                      )}
                      onClick={() => onOpenThreadGitAction(action.target)}
                    >
                      {action.label}
                    </Button>
                  )),
                ].map((action, index) =>
                  action ? (
                    <span
                      key={index}
                      className="inline-flex"
                      data-thread-header-responsive-action=""
                    >
                      {action}
                    </span>
                  ) : null,
                )}
          </div>
          <div
            className="ml-1 flex items-center gap-0.5"
            data-thread-header-pane-actions=""
          >
            <ThreadHeaderItems threadId={threadId} />
            <PaneMaximizeButton />
            {pane.onRequestClose ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
                  CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
                )}
                aria-label="Close pane"
                onClick={pane.onRequestClose}
              >
                <Icon name="CloseThreadPane" />
              </Button>
            ) : null}
            {pane.secondaryPanelHost === null &&
            (!isSecondaryPanelOpen || isCompactViewport) ? (
              <span className="inline-flex items-center gap-1.5">
                <AppCommandShortcutHint shortcut={panelShortcut} />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn(
                    HEADER_ICON_BUTTON_CLASS,
                    CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
                  )}
                  aria-label={
                    panelShortcut
                      ? `${rightPanelLabel} (${panelShortcut.label})`
                      : rightPanelLabel
                  }
                  aria-keyshortcuts={panelShortcut?.ariaKeyshortcuts}
                  aria-expanded={isSecondaryPanelOpen}
                  onClick={onToggleSecondaryPanel}
                >
                  <Icon name={RIGHT_PANEL_TOGGLE_ICON_NAME} />
                </Button>
              </span>
            ) : null}
            {pane.reservesWindowPanelToggle && !isWindowPanelOpen ? (
              <span aria-hidden className={HEADER_ICON_BUTTON_CLASS} />
            ) : null}
          </div>
        </>
      }
    />
  );
}
