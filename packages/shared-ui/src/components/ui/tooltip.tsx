import * as React from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "../../lib/portal-scope";
import {
  consumeEscape,
  isLastInputKeyboard,
  popper,
  slot,
  type PopperProps,
} from "./overlay-trigger.js";

const HoverableContext = React.createContext(true);
const TooltipContext = React.createContext<{
  id?: string;
  open?: boolean;
  delay?: number;
}>({});

function TooltipProvider({
  delayDuration = 700,
  disableHoverableContent = false,
  children,
}: {
  delayDuration?: number;
  disableHoverableContent?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <TooltipPrimitive.Provider delay={delayDuration} timeout={300}>
      <HoverableContext.Provider value={!disableHoverableContent}>
        {children}
      </HoverableContext.Provider>
    </TooltipPrimitive.Provider>
  );
}

function Tooltip({
  delayDuration,
  disableHoverableContent,
  children,
}: {
  delayDuration?: number;
  disableHoverableContent?: boolean;
  children?: React.ReactNode;
}) {
  const hoverable = React.useContext(HoverableContext);
  const id = React.useId();
  const [trigger, setTrigger] = React.useState<Element | null>(null);

  React.useEffect(() => {
    if (trigger === null) return;
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && event.target.contains(trigger)) {
        setTrigger(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      consumeEscape(event);
      setTrigger(null);
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [trigger]);

  return (
    <TooltipPrimitive.Root
      open={trigger !== null}
      onOpenChange={(open, details) =>
        setTrigger(open ? (details.trigger ?? null) : null)
      }
      disableHoverablePopup={
        disableHoverableContent === undefined
          ? !hoverable
          : disableHoverableContent
      }
    >
      <TooltipContext.Provider
        value={{ id, open: trigger !== null, delay: delayDuration }}
      >
        {children}
      </TooltipContext.Provider>
    </TooltipPrimitive.Root>
  );
}

function TooltipTrigger(props: {
  asChild?: boolean;
  children?: React.ReactNode;
}) {
  const { id, open, delay } = React.useContext(TooltipContext);
  const moved = React.useRef(false);
  return (
    <TooltipPrimitive.Trigger
      aria-describedby={open ? id : undefined}
      delay={delay}
      onFocus={(event) => {
        if (!isLastInputKeyboard()) event.preventBaseUIHandler();
      }}
      onMouseMove={(event) => {
        if (moved.current) event.preventBaseUIHandler();
        moved.current = true;
      }}
      onMouseLeave={() => {
        moved.current = false;
      }}
      {...slot(props)}
    />
  );
}

function TooltipContent({
  className,
  side,
  align,
  sideOffset = 4,
  collisionBoundary,
  collisionPadding = 8,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Popup> & PopperProps) {
  const { id } = React.useContext(TooltipContext);
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        className="pointer-events-auto! z-50"
        {...popper({
          side,
          align,
          sideOffset,
          collisionBoundary,
          collisionPadding,
        })}
      >
        <TooltipPrimitive.Popup
          {...usePortalScopeProps()}
          id={id}
          role="tooltip"
          className={cn(
            "max-w-[min(20rem,var(--available-width))] overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground break-words animate-in fade-in-0 zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
            className,
          )}
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
