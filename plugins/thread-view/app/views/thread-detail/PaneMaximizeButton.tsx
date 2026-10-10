import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Popover, PopoverAnchor, PopoverContent } from "@bb/shared-ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { useAppCommandShortcut } from "@bb/app-kit/components/commands/AppCommandProvider";
import { HEADER_PANE_ACTION_ICON_BUTTON_CLASS } from "@bb/app-kit/components/layout/AppPageHeader";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { useHoverPopover } from "../../components/ui/hooks/use-hover-popover";
import type { AppShortcutPresentation } from "@bb/app-kit/lib/app-keybindings";
import { useRef } from "react";
import type { SplitSide } from "@bb/app-kit/lib/split-layout";
import { cn } from "@bb/shared-ui/lib/utils";
import { usePaneContext } from "@bb/app-kit/views/thread-detail/PaneContext";

const ARRANGEMENT_REGION_CLASS: Record<SplitSide, string> = {
  left: "inset-y-[3px] left-[3px] w-2.5",
  right: "inset-y-[3px] right-[3px] w-2.5",
  top: "inset-x-[3px] top-[3px] h-1.5",
  bottom: "inset-x-[3px] bottom-[3px] h-1.5",
};
const SIDES = ["left", "right", "top", "bottom"] as const;

export function PaneMaximizeButton() {
  const { isMaximized, onToggleMaximize, onMoveToSide } = usePaneContext();
  const shortcut = useAppCommandShortcut("pane.maximize.toggle");
  if (onToggleMaximize === null) return null;
  return (
    <PaneArrangementButton
      isFullScreen={isMaximized}
      onMoveToSide={onMoveToSide}
      onToggleFullScreen={onToggleMaximize}
      shortcut={shortcut ?? undefined}
    />
  );
}

export function PaneArrangementButton({
  className,
  isFullScreen,
  onMoveToSide,
  onToggleFullScreen,
  shortcut,
}: {
  className?: string;
  isFullScreen: boolean;
  onMoveToSide?: (side: SplitSide) => void;
  onToggleFullScreen: () => void;
  shortcut?: AppShortcutPresentation;
}) {
  const hover = useHoverPopover({ openDelayMs: 400, closeDelayMs: 100 });
  const label = isFullScreen ? "Restore split" : "Maximize pane";
  const menuOpen = !isFullScreen && hover.open;
  const menuRef = useRef<HTMLDivElement>(null);
  const toggle = () => {
    hover.handleOpenChange(false);
    onToggleFullScreen();
  };
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
        CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
        className,
      )}
      aria-label={shortcut ? `${label} (${shortcut.label})` : label}
      aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
      aria-pressed={isFullScreen}
      aria-haspopup={!isFullScreen ? "menu" : undefined}
      aria-expanded={!isFullScreen ? menuOpen : undefined}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" || isFullScreen) return;
        event.preventDefault();
        hover.handleOpenChange(true);
        window.setTimeout(() => {
          menuRef.current
            ?.querySelector<HTMLElement>('[role="menuitem"]')
            ?.focus();
        }, 0);
      }}
      onClick={toggle}
      {...(!isFullScreen ? hover.triggerHoverProps : {})}
    >
      <Icon name={isFullScreen ? "Minimize2" : "Maximize2"} />
    </Button>
  );

  if (isFullScreen) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="bottom">
          <span>{label}</span>
          {shortcut ? ` (${shortcut.label})` : ""}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Popover open={menuOpen} onOpenChange={hover.handleOpenChange}>
      <PopoverAnchor asChild>{button}</PopoverAnchor>
      <PopoverContent
        ref={menuRef}
        role="menu"
        aria-label="Pane arrangement"
        side="bottom"
        align="end"
        sideOffset={6}
        className="w-52 space-y-1 rounded-lg p-1.5"
        {...hover.contentHoverProps}
      >
        <button
          type="button"
          role="menuitem"
          className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-foreground outline-none transition-colors hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none [&>[data-icon-root]]:size-4 [&>[data-icon-root]]:shrink-0"
          onClick={toggle}
        >
          <Icon name="Maximize2" />
          <span className="flex-1">{label}</span>
          {shortcut ? (
            <span className="text-subtle-foreground">{shortcut.label}</span>
          ) : null}
        </button>
        {onMoveToSide ? (
          <div className="border-t border-border-hairline pt-1.5">
            <div className="px-2 pb-0.5 text-2xs font-medium text-subtle-foreground">
              Move
            </div>
            <div className="grid grid-cols-4 gap-1" aria-label="Move pane">
              {SIDES.map((side) => (
                <Tooltip key={side}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      role="menuitem"
                      aria-label={`Move ${side}`}
                      className="flex h-11 cursor-pointer items-center justify-center rounded-md text-subtle-foreground outline-none transition-colors hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover focus-visible:text-foreground focus-visible:outline-none"
                      onClick={() => {
                        hover.handleOpenChange(false);
                        onMoveToSide(side);
                      }}
                    >
                      <span
                        data-pane-arrangement-glyph={side}
                        aria-hidden
                        className="relative block h-5 w-8 rounded-[5px] border-2 border-current"
                      >
                        <span
                          className={cn(
                            "absolute rounded-[2px] bg-current",
                            ARRANGEMENT_REGION_CLASS[side],
                          )}
                        />
                      </span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{`Move ${side}`}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
