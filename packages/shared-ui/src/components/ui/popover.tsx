import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "../../lib/portal-scope";
import {
  type ResponsiveOverlayContextValue,
  useResponsiveRoot,
} from "./responsive-overlay.js";
import {
  blurActiveKeyboardInputBeforeOverlayOpen,
  getOverlayTriggerClassName,
  preventOverlayTriggerSelection,
} from "./overlay-trigger.js";

const ResponsivePopoverContext =
  React.createContext<ResponsiveOverlayContextValue>({
    open: false,
    onOpenChange: () => {},
  });

function useResponsivePopover() {
  return React.useContext(ResponsivePopoverContext);
}

function Popover({
  children,
  open: controlledOpen,
  onOpenChange: controlledOnChange,
  defaultOpen,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const ctx = useResponsiveRoot(
    controlledOpen,
    controlledOnChange,
    defaultOpen,
  );

  return (
    <PopoverPrimitive.Root
      open={ctx.open}
      onOpenChange={ctx.onOpenChange}
      {...props}
    >
      <ResponsivePopoverContext.Provider value={ctx}>
        {children}
      </ResponsivePopoverContext.Provider>
    </PopoverPrimitive.Root>
  );
}

const PopoverTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>
>(({ asChild, children, className, ...props }, ref) => {
  const { open } = useResponsivePopover();

  return (
    <PopoverPrimitive.Trigger
      ref={ref}
      asChild={asChild}
      className={getOverlayTriggerClassName(className)}
      onMouseDown={(event) => {
        if (!open) {
          blurActiveKeyboardInputBeforeOverlayOpen();
        }
        preventOverlayTriggerSelection(event);
      }}
      {...props}
    >
      {children}
    </PopoverPrimitive.Trigger>
  );
});
PopoverTrigger.displayName = "PopoverTrigger";

const PopoverContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & {
    dismissOnOutsideInteraction?: boolean;
    autoFocusRef?: React.RefObject<HTMLElement | null>;
  }
>(
  (
    {
      className,
      align = "center",
      sideOffset = 4,
      children,
      dismissOnOutsideInteraction = true,
      onInteractOutside,
      onOpenAutoFocus,
      autoFocusRef,
      ...props
    },
    ref,
  ) => {
    const { open } = useResponsivePopover();
    const scopeProps = usePortalScopeProps();

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
          ref={ref}
          {...scopeProps}
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
          onInteractOutside={(event) => {
            if (!dismissOnOutsideInteraction) event.preventDefault();
            onInteractOutside?.(event);
          }}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    );
  },
);
PopoverContent.displayName = "PopoverContent";

const PopoverAnchor = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Anchor>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Anchor>
>(({ children, ...props }, ref) => {
  return (
    <PopoverPrimitive.Anchor ref={ref} {...props}>
      {children}
    </PopoverPrimitive.Anchor>
  );
});
PopoverAnchor.displayName = "PopoverAnchor";

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
