import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export const OPTION_BASE_CLASS_NAME =
  "h-8 w-fit max-w-full min-w-0 items-center justify-start gap-1 px-1 text-xs leading-tight";
export const OPTION_INTERACTIVE_CLASS_NAME =
  "border-none bg-transparent shadow-none";
export const OPTION_TRIGGER_CONTENT_CLASS_NAME = "contents";
export const OPTION_MENU_CONTENT_CLASS_NAME =
  "max-h-[min(var(--available-height),calc(100dvh-0.5rem))] w-max min-w-0 max-w-96 overflow-auto overflow-x-hidden overscroll-contain";
export const OPTION_MUTED_CLASS_NAME =
  "text-muted-foreground hover:text-muted-foreground";

export function OptionDisplay({
  label,
  value,
  leading,
  compactValue,
  className,
}: {
  label: string;
  value: ReactNode;
  leading?: ReactNode;
  compactValue?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-option-display=""
      title={typeof value === "string" ? `${label}: ${value}` : undefined}
      className={cn(
        "inline-flex",
        OPTION_BASE_CLASS_NAME,
        OPTION_MUTED_CLASS_NAME,
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {leading}
        <span className="sr-only">{label}: </span>
        <span className="min-w-0 truncate" data-promptbox-full-label="">
          {value}
        </span>
        {compactValue ? (
          <span className="min-w-0 truncate" data-promptbox-compact-label="">
            {compactValue}
          </span>
        ) : null}
      </span>
    </div>
  );
}
