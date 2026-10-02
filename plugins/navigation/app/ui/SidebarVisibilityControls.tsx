import { useCallback, useState, type ReactNode } from "react";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import {
  COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { SIDEBAR_DISCLOSURE_ACTION_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  PROJECT_LIST_ACTION_BUTTON_CLASS,
  SIDEBAR_HOVER_ACTIONS_CLASS,
  SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
} from "@bb/shared-ui/sidebar-row-classes";

const OVERFLOW_ROW_BUTTON_CLASS =
  "w-full justify-start gap-2 rounded-sm px-2 text-xs font-normal hover:bg-state-hover focus-visible:bg-state-hover";

export interface SidebarVisibilityItem {
  id: string;
  title: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SidebarActivationModifiers {
  metaKey: boolean;
  ctrlKey: boolean;
}

export function SidebarMore({
  activity,
  ariaLabel,
  children,
  listLabel,
  testIdPrefix = "sidebar-navigation",
}: {
  activity?: ReactNode;
  ariaLabel: string;
  children: (close: () => void) => ReactNode;
  listLabel: string;
  testIdPrefix?: string;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const close = useCallback(() => setIsMenuOpen(false), []);

  return (
    <div data-testid={`${testIdPrefix}-more-row`}>
      <Popover open={isMenuOpen} onOpenChange={setIsMenuOpen}>
        <div>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={ariaLabel}
              className={cn(
                PROJECT_LIST_ACTION_BUTTON_CLASS,
                SIDEBAR_DISCLOSURE_ACTION_CLASS,
                "w-full hover:text-sidebar-foreground focus-visible:text-sidebar-foreground data-[state=open]:text-sidebar-foreground",
                isMenuOpen && "bg-sidebar-accent",
              )}
              data-testid={`${testIdPrefix}-more-trigger`}
            >
              <Icon name="MoreHorizontal" aria-hidden="true" />
              <span className="min-w-0 truncate text-left">More</span>
              {activity ? (
                <span
                  className={cn(
                    "ml-auto inline-flex shrink-0 items-center justify-center",
                    COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
                  )}
                >
                  {activity}
                </span>
              ) : null}
            </Button>
          </PopoverTrigger>
        </div>
        <PopoverContent
          side="right"
          align="start"
          sideOffset={8}
          aria-label={ariaLabel}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (event.currentTarget instanceof HTMLElement) {
              event.currentTarget.focus();
            }
          }}
          className="flex max-h-[min(var(--radix-popover-content-available-height),calc(100dvh-0.5rem))] w-56 flex-col overflow-hidden p-1"
        >
          <div
            role="list"
            aria-label={listLabel}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            {children(close)}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function SidebarOverflowItem({
  activity,
  additionalActions,
  item,
  onActivate,
  onClose,
  testIdPrefix = "sidebar-navigation",
}: {
  activity?: ReactNode;
  additionalActions?: ReactNode;
  item: SidebarVisibilityItem;
  onActivate?: (event: SidebarActivationModifiers) => void;
  onClose: () => void;
  testIdPrefix?: string;
}) {
  const [isActionsOpen, setIsActionsOpen] = useState(false);

  const actions = (
    <DropdownMenu
      modal={false}
      open={isActionsOpen}
      onOpenChange={setIsActionsOpen}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`${item.title} options`}
          className={cn(
            COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
            "rounded-sm p-0 hover:bg-state-hover",
          )}
        >
          <Icon
            name="MoreHorizontal"
            className={COARSE_POINTER_ICON_SIZE_CLASS}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={4}
        aria-label={`${item.title} options`}
      >
        {additionalActions}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div role="listitem">
      <div className={cn(SIDEBAR_HOVER_ACTIONS_ROW_CLASS, "relative")}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            OVERFLOW_ROW_BUTTON_CLASS,
            COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS,
            "pr-9",
          )}
          disabled={item.disabled}
          data-sidebar-overflow-item={item.id}
          data-sidebar-navigation-more-item={
            testIdPrefix === "sidebar-navigation" ? item.id : undefined
          }
          onClick={(event) => {
            if (!onActivate) return;
            onClose();
            onActivate({ metaKey: event.metaKey, ctrlKey: event.ctrlKey });
          }}
        >
          {item.icon ? (
            <span className="flex size-4 shrink-0 items-center justify-center">
              {item.icon}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-left">
            {item.title}
          </span>
          {activity}
        </Button>
        <div
          data-sidebar-hover-actions-open={isActionsOpen ? "true" : undefined}
          className={cn(
            SIDEBAR_HOVER_ACTIONS_CLASS,
            "absolute inset-y-0 right-0 flex items-center",
          )}
        >
          {actions}
        </div>
      </div>
    </div>
  );
}
