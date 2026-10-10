import { useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

import {
  CONTEXT_CARD_ACTION_BUTTON_CLASS,
  CONTEXT_CARD_CLASS,
  CONTEXT_CARD_INSET_CLASS,
  CONTEXT_CARD_SEGMENT_CLASS,
} from "@bb/shared-ui/chrome-style-tokens";

export const PROMPT_STACK_CARD_ROW_HEIGHT = 32;
export const PROMPT_STACK_CARD_HEADER_BUTTON_CLASS =
  "flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-none px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-background/80";
export const PROMPT_STACK_INLAY_INSET_CLASS = CONTEXT_CARD_INSET_CLASS;
export const PROMPT_STACK_INLAY_SEGMENT_CLASS = CONTEXT_CARD_SEGMENT_CLASS;
export const PROMPT_STACK_EDGE_CARET_BUTTON_WIDTH_CLASS = "w-6 px-0";
export const PROMPT_STACK_TRACK_CLASS = "grid-cols-[minmax(0,1fr)]";
export const PROMPT_STACK_ROW_ACTION_TAKEOVER_CLASS =
  "relative bg-surface-raised-solid before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-4 before:bg-gradient-to-r before:from-transparent before:to-surface-raised-solid before:content-['']";
export const PROMPT_BANNER_ACTION_BUTTON_CLASS =
  CONTEXT_CARD_ACTION_BUTTON_CLASS;

export function PromptStackCard({
  children,
  ariaLabel,
  className,
  rootRef,
  style,
}: {
  children: ReactNode;
  ariaLabel?: string;
  className?: string;
  rootRef?: Ref<HTMLElement>;
  style?: CSSProperties;
}) {
  const Root = ariaLabel ? "section" : "div";
  return (
    <Root
      ref={rootRef as Ref<HTMLDivElement>}
      aria-label={ariaLabel}
      className={cn(CONTEXT_CARD_CLASS, className)}
      style={style}
    >
      {children}
    </Root>
  );
}

export function PromptStackCardChevron({
  isExpanded,
  className,
}: {
  isExpanded: boolean;
  className: string;
}) {
  return (
    <Icon
      name="ChevronDown"
      className={cn(
        className,
        "size-3.5 shrink-0 transition-transform duration-200",
        isExpanded && "rotate-180",
      )}
      aria-hidden="true"
    />
  );
}

export function AnimatedBody({
  id,
  labelledBy,
  isExpanded,
  collapsedBorder,
  children,
}: {
  id: string;
  labelledBy: string;
  isExpanded: boolean;
  collapsedBorder: "reserve" | "none";
  children: ReactNode;
}) {
  const [hasRealizedBody, setHasRealizedBody] = useState(isExpanded);
  if (isExpanded && !hasRealizedBody) {
    setHasRealizedBody(true);
  }

  return (
    <section
      id={id}
      role="region"
      aria-labelledby={labelledBy}
      aria-hidden={!isExpanded}
      className={cn(
        "grid overflow-hidden transition-[grid-template-rows,opacity,border-color] duration-200 ease-out",
        isExpanded
          ? "grid-rows-[1fr] border-t border-border opacity-100"
          : cn(
              "pointer-events-none grid-rows-[0fr] opacity-0",
              collapsedBorder === "reserve" && "border-t border-transparent",
            ),
      )}
    >
      <div className="overflow-hidden bg-popover">
        {hasRealizedBody || isExpanded ? children : null}
      </div>
    </section>
  );
}

export function BannerActionSlot({
  children,
  hideInCompact = false,
}: {
  children: ReactNode;
  hideInCompact?: boolean;
}) {
  return (
    <div
      className="ml-auto flex shrink-0 items-center gap-1.5 pr-2 text-xs text-muted-foreground"
      data-context-merge-base={hideInCompact ? "" : undefined}
      data-promptbox-hide-compact={hideInCompact ? "" : undefined}
      data-promptbox-hide-tiny=""
    >
      {children}
    </div>
  );
}
