import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "../../lib/portal-scope";
import { useLayer, useModalLayer, type OverlayLayer } from "./overlay-layer.js";
import { autoFocus, loopTabFocus, PORTAL_CLASS } from "./overlay-trigger.js";
import { Icon } from "../../components/ui/icon.js";

type OpenChangeDetails = DialogPrimitive.Root.ChangeEventDetails;

const DialogContext = React.createContext<{
  id?: string;
  open: boolean;
  modal: boolean;
  layer: OverlayLayer | null;
}>({ open: false, modal: true, layer: null });

function Dialog({
  children,
  open = false,
  onOpenChange,
  modal = true,
  disablePointerDismissal,
}: {
  children?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean, details?: OpenChangeDetails) => void;
  modal?: boolean;
  disablePointerDismissal?: boolean;
}) {
  const id = React.useId();
  const layer = useLayer(
    open,
    modal,
    id,
    modal ? undefined : () => onOpenChange?.(false),
  );
  return (
    <DialogPrimitive.Root
      actionsRef={layer.actionsRef}
      open={open}
      onOpenChange={(next, details) => {
        if (!layer.ignores(details)) onOpenChange?.(next, details);
      }}
      modal={modal}
      disablePointerDismissal={disablePointerDismissal}
    >
      <DialogContext.Provider value={{ id, open, modal, layer }}>
        {children}
      </DialogContext.Provider>
    </DialogPrimitive.Root>
  );
}

function ModalLayer() {
  const { id, open, layer } = React.useContext(DialogContext);
  useModalLayer(id, open, "dialog", layer);
  return null;
}

function DialogContent({
  className,
  children,
  hideCloseButton = false,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onAfterCloseAutoFocus,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Popup>, "className"> & {
  className?: string;
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onAfterCloseAutoFocus?: () => void;
  hideCloseButton?: boolean;
}) {
  const { id, open, modal, layer } = React.useContext(DialogContext);
  const scopeProps = usePortalScopeProps();
  return (
    <DialogPrimitive.Portal className={PORTAL_CLASS}>
      {modal ? (
        <DialogPrimitive.Backdrop
          {...scopeProps}
          forceRender
          className="fixed inset-0 z-50 bg-black/40 data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-closed:fill-mode-forwards data-open:fade-in-0"
        />
      ) : null}
      <DialogPrimitive.Popup
        {...scopeProps}
        id={id}
        initialFocus={autoFocus(onOpenAutoFocus)}
        finalFocus={() => {
          window.setTimeout(() => {
            onCloseAutoFocus?.(new Event("focus", { cancelable: true }));
            queueMicrotask(() => onAfterCloseAutoFocus?.());
          }, 0);
          return false;
        }}
        className={cn(
          "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg grid-cols-[minmax(0,1fr)] translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-sm duration-200 data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 sm:rounded-lg",
          className,
        )}
        {...props}
        onPointerDownCapture={layer?.markPressInside}
        onFocus={(event) => {
          props.onFocus?.(event);
          if (!open && event.target === event.currentTarget) {
            event.currentTarget.blur();
          }
        }}
        onKeyDown={(event) => {
          props.onKeyDown?.(event);
          loopTabFocus(event);
        }}
      >
        {children}
        {hideCloseButton ? null : (
          <DialogPrimitive.Close className="absolute right-4 top-4 cursor-pointer rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
            <Icon name="X" className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
        {modal ? <ModalLayer /> : null}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col space-y-1.5 text-left", className)}
    {...props}
  />
);

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

function DialogTitle({
  className,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Title>, "className"> & {
  className?: string;
}) {
  return (
    <DialogPrimitive.Title
      className={cn(
        "text-base font-semibold leading-none tracking-tight",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: Omit<
  React.ComponentProps<typeof DialogPrimitive.Description>,
  "className"
> & { className?: string }) {
  return (
    <DialogPrimitive.Description
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
