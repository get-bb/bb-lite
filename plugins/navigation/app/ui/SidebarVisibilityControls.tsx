import { useCallback, useRef, useState, type ReactNode } from "react";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import { COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { SIDEBAR_DISCLOSURE_ACTION_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { cn } from "@bb/shared-ui/lib/utils";
import { PROJECT_LIST_ACTION_BUTTON_CLASS } from "@bb/shared-ui/sidebar-row-classes";

export function SidebarMore({
  ariaLabel,
  children,
  listLabel,
}: {
  ariaLabel: string;
  children: (close: () => void) => ReactNode;
  listLabel: string;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const close = useCallback(() => setIsMenuOpen(false), []);
  const contentRef = useRef<HTMLDivElement>(null);

  return (
    <div data-testid="sidebar-navigation-more-row">
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
              data-testid="sidebar-navigation-more-trigger"
            >
              <Icon name="MoreHorizontal" aria-hidden="true" />
              <span className="min-w-0 truncate text-left">More</span>
            </Button>
          </PopoverTrigger>
        </div>
        <PopoverContent
          side="right"
          align="start"
          sideOffset={8}
          mobileTitle="More"
          aria-label={ariaLabel}
          ref={contentRef}
          initialFocus={contentRef}
          className="flex max-h-[min(var(--available-height),calc(100dvh-0.5rem))] w-56 flex-col overflow-hidden p-1 max-md:min-h-0 max-md:flex-1"
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
  item,
  onActivate,
}: {
  item: { id: string; title: string; icon: ReactNode; disabled: boolean };
  onActivate: () => void;
}) {
  return (
    <div role="listitem">
      <div className="relative">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "w-full justify-start gap-2 rounded-sm px-2 text-xs font-normal hover:bg-state-hover focus-visible:bg-state-hover",
            COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS,
            "pr-9 max-md:pointer-coarse:pr-11",
          )}
          disabled={item.disabled}
          data-sidebar-overflow-item={item.id}
          data-sidebar-navigation-more-item={item.id}
          onClick={onActivate}
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            {item.icon}
          </span>
          <span className="min-w-0 flex-1 truncate text-left">
            {item.title}
          </span>
        </Button>
      </div>
    </div>
  );
}
