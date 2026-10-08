import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { CompactLongPressMenu } from "@bb/shared-ui/compact-long-press-menu";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { CONTROL_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import { composer, type ComposerContext } from "@bb/plugin/app";
import { useComposerItems } from "./composer-slots";

export function ComposerSendMenu({
  children,
  isPointerCoarse,
  context,
  hasInput,
  canSubmit,
}: {
  children: ReactNode;
  isPointerCoarse: boolean;
  context: ComposerContext;
  hasInput: boolean;
  canSubmit: boolean;
}) {
  const available = useComposerItems(composer.sendMenuItem, context);
  const isCompactViewport = useIsCompactViewport();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!canSubmit) setOpen(false);
  }, [canSubmit]);
  const handleOpenChange = (nextOpen: boolean) =>
    setOpen(nextOpen && canSubmit);

  if (available.length === 0) return children;

  const items = canSubmit
    ? available.map((item) => (
        <DropdownMenuItem
          key={item.id}
          disabled={!canSubmit}
          onSelect={() => item.run(context)}
        >
          <Icon
            name={item.icon as IconName}
            className={cn("size-4", item.iconClassName)}
          />
          {item.label}
        </DropdownMenuItem>
      ))
    : null;

  if (isPointerCoarse && isCompactViewport) {
    if (!canSubmit) return children;
    return (
      <CompactLongPressMenu
        label="Send options"
        onOpenChange={handleOpenChange}
        items={items}
      >
        <span
          className="inline-flex"
          onPointerUpCapture={(event) => {
            if (!open) return;
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {children}
        </span>
      </CompactLongPressMenu>
    );
  }

  return (
    <div
      data-promptbox-send-menu=""
      className={cn(
        "group/send ml-1 inline-flex items-center rounded-md [&_[data-promptbox-submit-action]]:ml-0",
        CONTROL_HOVER_TRANSITION,
        "bg-foreground text-background [&_button]:!bg-transparent [&_button]:!text-inherit [&_button]:!opacity-100",
        hasInput && "[&_[data-promptbox-submit-action]]:rounded-r-none",
        canSubmit
          ? "[&_button:hover]:!bg-background/15 [&_button[data-state=open]]:!bg-background/15"
          : "opacity-50",
      )}
    >
      {children}
      <DropdownMenu open={open && canSubmit} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="Send options"
            disabled={!canSubmit}
            aria-hidden={hasInput ? undefined : true}
            className={cn(
              "min-w-0 overflow-hidden rounded-l-none px-0 transition-[width] duration-150 ease-out motion-reduce:transition-none",
              hasInput ? "w-6" : "w-0",
            )}
          >
            <Icon
              name="ChevronDown"
              className="opacity-50 transition-opacity duration-150 group-hover/send:opacity-100 group-focus-within/send:opacity-100 motion-reduce:transition-none"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" mobileTitle="Send options">
          {items}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
