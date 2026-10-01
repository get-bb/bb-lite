import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

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
import { Icon } from "../../components/ui/icon.js";

const ResponsiveDialogContext =
  React.createContext<ResponsiveOverlayContextValue>({
    open: false,
    onOpenChange: () => {},
  });

function useResponsiveDialog() {
  return React.useContext(ResponsiveDialogContext);
}

function Dialog({
  children,
  open: controlledOpen,
  onOpenChange: controlledOnChange,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const ctx = useResponsiveRoot(controlledOpen, controlledOnChange);

  return (
    <ResponsiveDialogContext.Provider value={ctx}>
      <DialogPrimitive.Root
        open={ctx.open}
        onOpenChange={ctx.onOpenChange}
        {...props}
      >
        {children}
      </DialogPrimitive.Root>
    </ResponsiveDialogContext.Provider>
  );
}

const DialogTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>
>(({ asChild, children, className, ...props }, ref) => {
  const { open } = useResponsiveDialog();

  return (
    <DialogPrimitive.Trigger
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
    </DialogPrimitive.Trigger>
  );
});
DialogTrigger.displayName = "DialogTrigger";

interface DialogCloseProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
}

const DialogClose = React.forwardRef<HTMLButtonElement, DialogCloseProps>(
  ({ asChild, onClick, children, ...props }, ref) => {
    return (
      <DialogPrimitive.Close
        ref={ref}
        asChild={asChild}
        onClick={onClick}
        {...props}
      >
        {children}
      </DialogPrimitive.Close>
    );
  },
);
DialogClose.displayName = "DialogClose";

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    {...usePortalScopeProps()}
    className={cn(
      "fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

type DialogContentProps = React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> & {
  onAfterCloseAutoFocus?: () => void;
  hideCloseButton?: boolean;
};

const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
  (
    {
      className,
      children,
      hideCloseButton = false,
      onAfterCloseAutoFocus,
      onCloseAutoFocus,
      ...props
    },
    ref,
  ) => {
    const scopeProps = usePortalScopeProps();

    return (
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content
          ref={ref}
          {...scopeProps}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            queueMicrotask(() => onAfterCloseAutoFocus?.());
          }}
          className={cn(
            "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg grid-cols-[minmax(0,1fr)] translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-sm duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded-lg",
            className,
          )}
          {...props}
        >
          {children}
          {hideCloseButton ? null : (
            <DialogPrimitive.Close className="absolute right-4 top-4 cursor-pointer rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-state-active data-[state=open]:text-foreground">
              <Icon name="X" className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    );
  },
);
DialogContent.displayName = "DialogContent";

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col space-y-1.5 text-left", className)}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ asChild, className, id, children, ...props }, ref) => {
  return (
    <DialogPrimitive.Title
      ref={ref}
      asChild={asChild}
      {...(id === undefined ? {} : { id })}
      className={cn(
        "text-base font-semibold leading-none tracking-tight",
        className,
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Title>
  );
});
DialogTitle.displayName = "DialogTitle";

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ asChild, className, id, children, ...props }, ref) => {
  return (
    <DialogPrimitive.Description
      ref={ref}
      asChild={asChild}
      {...(id === undefined ? {} : { id })}
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    >
      {children}
    </DialogPrimitive.Description>
  );
});
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
