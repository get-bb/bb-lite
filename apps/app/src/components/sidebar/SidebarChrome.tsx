import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { cn } from "@bb/shared-ui/lib/utils";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { COARSE_POINTER_HEADER_ICON_BUTTON_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { CHROME_ROW_CLASS } from "@/lib/chrome-row";
import { useRouteStateHistoryNavigation } from "@/lib/app-route-history";

const BROWSER_HEADER_SLOT_START_CLASS =
  "pl-[calc(12px_+_var(--bb-sidebar-control-size)_-_4px)]";

const HISTORY_NAV_BUTTON_CLASS = cn(
  COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
  "text-muted-foreground ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2",
);

export function SidebarTopReserveRow({
  testId,
  renderHeaderSlot,
}: {
  testId: string;
  renderHeaderSlot?: (startInsetClassName: string) => ReactNode;
}) {
  const history = useRouteStateHistoryNavigation();
  const buttons = [
    ["ChevronLeft", "Go back", history.canGoBack, history.goBack],
    ["ChevronRight", "Go forward", history.canGoForward, history.goForward],
  ] as const;
  return (
    <div
      data-testid={testId}
      className={cn(CHROME_ROW_CLASS, "shrink-0 justify-end gap-1 px-2")}
    >
      {renderHeaderSlot?.(BROWSER_HEADER_SLOT_START_CLASS)}
      <div className="flex items-center gap-1 shrink-0">
        {buttons.map(([icon, label, enabled, go]) => (
          <Button
            key={label}
            type="button"
            variant="ghost"
            size="icon"
            className={HISTORY_NAV_BUTTON_CLASS}
            onClick={go}
            disabled={!enabled}
            aria-label={label}
          >
            <Icon name={icon} aria-hidden />
          </Button>
        ))}
      </div>
    </div>
  );
}

export function SidebarResizeHandle({
  isResizing,
  onMouseDown,
  testId,
}: {
  isResizing: boolean;
  onMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "absolute -right-1.5 top-0 z-30 hidden h-full w-3 cursor-col-resize md:block",
        "before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors hover:before:bg-sidebar-border",
        isResizing && "before:bg-sidebar-border",
      )}
      onMouseDown={onMouseDown}
    />
  );
}
