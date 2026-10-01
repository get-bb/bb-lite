import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { cn } from "@bb/shared-ui/lib/utils";
import { CHROME_ROW_CLASS } from "@/lib/chrome-row";
import { SidebarHistoryNavigationControls } from "./SidebarHistoryNavigationControls";

const BROWSER_HEADER_SLOT_START_CLASS =
  "pl-[calc(12px_+_var(--bb-sidebar-control-size)_-_4px)]";

export function SidebarTopReserveRow({
  testId,
  renderHeaderSlot,
}: {
  testId: string;
  renderHeaderSlot?: (startInsetClassName: string) => ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(CHROME_ROW_CLASS, "shrink-0 justify-end gap-1 px-2")}
    >
      {renderHeaderSlot?.(BROWSER_HEADER_SLOT_START_CLASS)}
      <SidebarHistoryNavigationControls className="shrink-0" />
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
