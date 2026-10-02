import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "../../lib/portal-scope";
import { overlayTriggerProps, useOverlayOpen } from "./overlay-trigger.js";

const PopoverOpenContext = React.createContext(false);

function Popover({
  children,
  open,
  onOpenChange,
  defaultOpen,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const state = useOverlayOpen(open, onOpenChange, defaultOpen);
  return (
    <PopoverPrimitive.Root {...state} {...props}>
      <PopoverOpenContext.Provider value={state.open}>
        {children}
      </PopoverOpenContext.Provider>
    </PopoverPrimitive.Root>
  );
}

function PopoverTrigger({
  className,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  const open = React.useContext(PopoverOpenContext);
  return (
    <PopoverPrimitive.Trigger
      {...overlayTriggerProps(open, className)}
      {...props}
    />
  );
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  onOpenAutoFocus,
  autoFocusRef,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & {
  autoFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const open = React.useContext(PopoverOpenContext);

  React.useEffect(() => {
    if (!open || !autoFocusRef) return;
    const frame = window.requestAnimationFrame(() => {
      const target = autoFocusRef.current;
      target?.focus();
      if (target instanceof HTMLInputElement) target.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocusRef, open]);

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        {...usePortalScopeProps()}
        align={align}
        sideOffset={sideOffset}
        onOpenAutoFocus={(event) => {
          if (autoFocusRef) event.preventDefault();
          onOpenAutoFocus?.(event);
        }}
        className={cn(
          "z-50 w-96 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

const PopoverAnchor = PopoverPrimitive.Anchor;

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
