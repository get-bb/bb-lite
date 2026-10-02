import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import type { ReactNode } from "react";
import { CONTEXT_SELECTION_SURFACE_CLASS } from "./context-selection";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";

const TAB_PILL_AFFORDANCE_BUTTON_BASE_CLASS =
  "inline-flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted-foreground/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none";
const TAB_PILL_CLOSE_BUTTON_CLASS = `pointer-events-none absolute left-1.5 top-1/2 z-10 -translate-y-1/2 ${TAB_PILL_AFFORDANCE_BUTTON_BASE_CLASS} opacity-0 hover:opacity-100 group-hover/tab-pill:pointer-events-auto group-hover/tab-pill:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 disabled:opacity-30`;
const TAB_PILL_LEADING_VISUAL_CLASS =
  "inline-flex size-4 shrink-0 items-center justify-center [&_[data-icon-root]]:size-3.5";

interface TabPillCloseAction {
  onClose: () => void;
  closeLabel: string;
  tooltip?: string;
}

export function TabPill({
  label,
  ariaLabel,
  ariaKeyshortcuts,
  iconOnly = false,
  leadingVisual,
  secondaryLabel = null,
  title,
  isActive,
  onSelect,
  labelMaxWidthClass = "max-w-[180px]",
  closeAction,
}: {
  label: string;
  ariaLabel?: string;
  ariaKeyshortcuts?: string;
  iconOnly?: boolean;
  leadingVisual?: ReactNode;
  secondaryLabel?: string | null;
  title: string;
  isActive: boolean;
  onSelect: () => void;
  labelMaxWidthClass?: string;
  closeAction: TabPillCloseAction | null;
}) {
  return (
    <div
      onAuxClick={(event) => {
        if (event.button !== 1 || closeAction === null) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        closeAction.onClose();
      }}
      className={cn(
        `group/tab-pill relative inline-flex h-7 shrink-0 items-center rounded-md ${LIST_HOVER_TRANSITION}`,
        "text-xs",
        isActive
          ? cn(CONTEXT_SELECTION_SURFACE_CLASS, "text-foreground")
          : "text-muted-foreground hover:bg-state-hover",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-label={ariaLabel}
        aria-keyshortcuts={ariaKeyshortcuts}
        aria-pressed={isActive}
        className={cn(
          "flex h-full min-w-0 items-center rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          iconOnly ? "px-1.5" : "pl-1.5 pr-2",
        )}
      >
        {leadingVisual ? (
          <span
            className={cn(
              TAB_PILL_LEADING_VISUAL_CLASS,
              !iconOnly && "mr-1.5",
              closeAction &&
                "group-hover/tab-pill:opacity-0 tab-pill-close-focus-visible:opacity-0",
            )}
          >
            {leadingVisual}
          </span>
        ) : null}
        <span
          className={cn(
            iconOnly ? "sr-only" : "truncate",
            !iconOnly && labelMaxWidthClass,
          )}
          title={iconOnly ? undefined : title}
        >
          {label}
        </span>
        {secondaryLabel ? (
          <span className="ml-1 shrink-0 text-muted-foreground">
            {secondaryLabel}
          </span>
        ) : null}
      </button>
      {closeAction ? <TabPillCloseButton closeAction={closeAction} /> : null}
    </div>
  );
}

function TabPillCloseButton({
  closeAction,
}: {
  closeAction: TabPillCloseAction;
}) {
  const button = (
    <button
      type="button"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={closeAction.onClose}
      aria-label={closeAction.closeLabel}
      data-tab-pill-close
      className={cn(TAB_PILL_CLOSE_BUTTON_CLASS)}
    >
      <Icon name="X" className="size-3.5" />
    </button>
  );
  return closeAction.tooltip === undefined ? (
    button
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{closeAction.tooltip}</TooltipContent>
    </Tooltip>
  );
}
