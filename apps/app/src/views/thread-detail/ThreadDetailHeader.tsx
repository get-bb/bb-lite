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
} from "@/components/layout/AppPageHeader";
import type { ThreadGitActionDialogTarget } from "@/components/dialogs/ThreadGitActionDialog";
import { cn } from "@bb/shared-ui/lib/utils";
import { useAppCommandShortcut } from "@/components/commands/AppCommandProvider";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { useInlineRename } from "@/components/sidebar/SidebarInlineRename";
import { useThreadActions } from "@/components/thread/ThreadActionsProvider";
import { ThreadTitle } from "@/components/thread/ThreadTitleMentions";
import { SecondaryPanelHostLayoutContext } from "@/components/secondary-panel/SecondaryPanelHostLayoutContext";
import { RIGHT_PANEL_TOGGLE_ICON_NAME } from "@/components/secondary-panel/panelToggleControlState";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { dimInactiveSplitsAtom } from "@/lib/split-layout/atoms";
import {
  CONTEXT_INACTIVE_TEXT_CLASS,
  CONTEXT_SELECTION_SURFACE_CLASS,
} from "@/components/ui/context-selection";
import { usePaneContext } from "./PaneContext";
import { PaneMaximizeButton } from "./PaneMaximizeButton";
import type { ThreadHeaderGitAction } from "./useThreadGitActions";

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
  const { renameThreadAsync } = useThreadActions();
  const { editor, isEditing, startEditing } = useInlineRename({
    id: threadId,
    name: threadTitle,
    label: "Thread name",
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
            {pane.secondaryPanelHost === null && !isSecondaryPanelOpen ? (
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
                      ? `Show right panel (${panelShortcut.label})`
                      : "Show right panel"
                  }
                  aria-keyshortcuts={panelShortcut?.ariaKeyshortcuts}
                  aria-expanded={false}
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
