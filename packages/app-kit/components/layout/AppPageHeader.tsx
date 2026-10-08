import type { ReactNode, Ref } from "react";
import { useIsSidebarShowing } from "../ui/sidebar";
import {
  COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
  COARSE_POINTER_HEADER_REDUCED_GLYPH_ICON_BUTTON_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import {
  BROWSER_COLLAPSED_HEADER_RESERVE_CLASS,
  CHROME_ROW_CLASS,
  CHROME_ROW_HEIGHT_CLASS,
} from "../../lib/chrome-row";
import { cn } from "@bb/shared-ui/lib/utils";

export const HEADER_ICON_BUTTON_CLASS = COARSE_POINTER_HEADER_ICON_BUTTON_CLASS;

export const HEADER_PANE_ACTION_ICON_BUTTON_CLASS =
  COARSE_POINTER_HEADER_REDUCED_GLYPH_ICON_BUTTON_CLASS;

export const HEADER_SEAM_CLASS = "border-b border-border-seam-vertical/60";

export function AppPageHeader({
  center,
  actions,
  className,
  headerRef,
  ownsWindowTopLeft = true,
}: {
  center?: ReactNode;
  actions?: ReactNode;
  className?: string;
  headerRef?: Ref<HTMLElement>;
  ownsWindowTopLeft?: boolean;
}) {
  const isSidebarShowing = useIsSidebarShowing();
  const isCompactViewport = useIsCompactViewport();
  return (
    <header
      ref={headerRef}
      className={cn(
        CHROME_ROW_HEIGHT_CLASS,
        HEADER_SEAM_CLASS,
        "bg-surface-scrim",
        "relative shrink-0 select-none px-4",
        className,
      )}
    >
      <div
        data-testid="app-page-header-content-row"
        className={cn(
          CHROME_ROW_CLASS,
          "relative z-10 gap-1 md:gap-2",
          "transition-[padding] duration-200 ease-linear",
          ownsWindowTopLeft &&
            (isCompactViewport || !isSidebarShowing) &&
            BROWSER_COLLAPSED_HEADER_RESERVE_CLASS,
        )}
      >
        {center ? (
          <div className="flex min-w-0 flex-1 items-center">
            <div className="flex min-w-0 max-w-full items-center gap-2">
              {center}
            </div>
          </div>
        ) : (
          <div className="min-w-0 flex-1" />
        )}
        {actions ? (
          <div className="flex shrink-0 items-center gap-1">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}
