import type { ReactNode, RefObject } from "react";
import { Button } from "@bb/shared-ui/button";
import { CHROME_SECTION_LABEL_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { cn } from "@bb/shared-ui/lib/utils";

export function SidebarVisibilityCustomizeFrame({
  children,
  containerRef,
  onDone,
  testId,
  title,
}: {
  children: ReactNode;
  containerRef?: RefObject<HTMLDivElement | null>;
  onDone: () => void;
  testId?: string;
  title: string;
}) {
  return (
    <div
      ref={containerRef}
      className="rounded-lg border border-sidebar-border/40 bg-sidebar-accent/40 p-1"
      data-testid={testId}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onDone();
      }}
    >
      <div className="flex items-center gap-1 pb-1">
        <div
          className={cn("min-w-0 flex-1 px-2 py-1", CHROME_SECTION_LABEL_CLASS)}
        >
          {title}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 px-2 text-xs text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent focus-visible:ring-2"
          onClick={onDone}
        >
          Done
        </Button>
      </div>
      {children}
    </div>
  );
}
