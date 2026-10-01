import { Button } from "../button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { Icon, type IconName } from "../icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../tooltip";
import { cn } from "../../../lib/utils";
import { COARSE_POINTER_HOVER_REVEAL_VISIBLE_CLASS } from "../coarse-pointer-visibility";

export function targetsResourceAction(event: {
  currentTarget: Element;
  target: EventTarget;
}): boolean {
  const { currentTarget, target } = event;
  return (
    target instanceof Element &&
    (!currentTarget.contains(target) ||
      target.closest("a, button, [data-row-action]") !== null)
  );
}

export type ResourceOverflowMenuItem =
  | {
      kind?: "item";
      label: string;
      icon?: IconName;
      tone?: "default" | "destructive";
      disabled?: boolean;
      disabledReason?: string;
      onSelect: () => void;
    }
  | { kind: "separator" };

export function ResourceOverflowMenu({
  label,
  disabled = false,
  items,
}: {
  label: string;
  disabled?: boolean;
  items: readonly ResourceOverflowMenuItem[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 p-0 text-muted-foreground hover:text-foreground"
          aria-label={label}
          disabled={disabled}
        >
          <Icon name="MoreHorizontal" className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-max min-w-32 max-w-72"
        mobileTitle={label}
      >
        {items.map((item, index) => {
          if (item.kind === "separator") {
            return <DropdownMenuSeparator key={`separator-${index}`} />;
          }
          const menuItem = (
            <DropdownMenuItem
              key={item.label}
              variant={item.tone === "destructive" ? "destructive" : "default"}
              disabled={item.disabled && item.disabledReason === undefined}
              aria-disabled={item.disabled || undefined}
              className={cn(
                item.disabled && "text-muted-foreground",
                item.disabledReason !== undefined &&
                  "cursor-not-allowed focus:bg-transparent",
              )}
              onSelect={(event) => {
                if (item.disabled) {
                  event.preventDefault();
                  return;
                }
                item.onSelect();
              }}
            >
              {item.icon ? (
                <Icon
                  name={item.icon}
                  className={cn(
                    "size-4 shrink-0",
                    item.disabled && "opacity-50",
                  )}
                  aria-hidden
                />
              ) : null}
              <span className="min-w-0 truncate">{item.label}</span>
            </DropdownMenuItem>
          );
          if (!item.disabled || item.disabledReason === undefined) {
            return menuItem;
          }
          return (
            <TooltipProvider key={item.label} delayDuration={250}>
              <Tooltip>
                <TooltipTrigger asChild>{menuItem}</TooltipTrigger>
                <TooltipContent side="left">
                  {item.disabledReason}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ResourceRowDetailChevron() {
  return (
    <Icon
      name="ChevronRight"
      className={cn(
        "size-3.5 text-subtle-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
        COARSE_POINTER_HOVER_REVEAL_VISIBLE_CLASS,
      )}
      aria-hidden
    />
  );
}
