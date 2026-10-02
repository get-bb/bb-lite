import * as React from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useRender } from "@base-ui/react/use-render";

import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "../../lib/portal-scope";
import {
  autoFocus,
  escapeAlreadyConsumed,
  loopTabFocus,
  MODAL_PORTAL_CLASS,
  overlayTriggerProps,
  popper,
  slot,
  useModalLayer,
  useOutsidePress,
  useOverlayOpen,
  usePopupActions,
  type PopperProps,
} from "./overlay-trigger.js";

const PopoverContext = React.createContext<{
  id?: string;
  open: boolean;
  modal: boolean;
  press: ReturnType<typeof useOutsidePress> | null;
  anchor: Element | null;
  setAnchor: (anchor: Element | null) => void;
}>({
  open: false,
  modal: false,
  press: null,
  anchor: null,
  setAnchor: () => {},
});

function Popover({
  children,
  open,
  onOpenChange,
  defaultOpen,
  modal = false,
}: {
  children?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  modal?: boolean;
}) {
  const state = useOverlayOpen(open, onOpenChange, defaultOpen);
  const press = useOutsidePress(state.open, () => state.onOpenChange(false));
  const id = React.useId();
  const actionsRef = usePopupActions(state.open, id);
  const [anchor, setAnchor] = React.useState<Element | null>(null);
  return (
    <PopoverPrimitive.Root
      actionsRef={actionsRef}
      open={state.open}
      onOpenChange={(next, details) => {
        if (escapeAlreadyConsumed(details)) return;
        const { reason } = details;
        press.current.outside =
          reason === "outside-press" ||
          reason === "focus-out" ||
          reason === "trigger-press";
        state.onOpenChange(next);
      }}
      modal={modal}
    >
      <PopoverContext.Provider
        value={{ id, open: state.open, modal, press, anchor, setAnchor }}
      >
        {children}
      </PopoverContext.Provider>
    </PopoverPrimitive.Root>
  );
}

function PopoverTrigger({
  className,
  ...props
}: {
  asChild?: boolean;
  disabled?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  const { open, press } = React.useContext(PopoverContext);
  return (
    <PopoverPrimitive.Trigger
      data-state={open ? "open" : "closed"}
      onPointerDownCapture={() => {
        if (press) press.current.inside = true;
      }}
      {...overlayTriggerProps(open, className)}
      {...slot(props)}
    />
  );
}

function PopoverAnchor({
  children,
}: {
  asChild: true;
  children: React.ReactElement<Record<string, unknown>>;
}) {
  const { setAnchor } = React.useContext(PopoverContext);
  return useRender({ render: children, ref: setAnchor });
}

function ModalParts() {
  const { id, open } = React.useContext(PopoverContext);
  useModalLayer(id, open, "popover");
  return <PopoverPrimitive.Close hidden />;
}

function PopoverContent({
  className,
  side,
  align = "center",
  sideOffset = 4,
  collisionPadding,
  onOpenAutoFocus,
  onCloseAutoFocus,
  autoFocusRef,
  onKeyDown,
  children,
  ...props
}: Omit<React.ComponentProps<typeof PopoverPrimitive.Popup>, "className"> &
  PopperProps & {
    className?: string;
    autoFocusRef?: React.RefObject<HTMLElement | null>;
    onOpenAutoFocus?: (event: Event) => void;
    onCloseAutoFocus?: (event: Event) => void;
  }) {
  const { id, open, modal, press, anchor } = React.useContext(PopoverContext);
  const returnFocus = autoFocus(onCloseAutoFocus);

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
    <PopoverPrimitive.Portal className={modal ? MODAL_PORTAL_CLASS : undefined}>
      <PopoverPrimitive.Positioner
        className="z-50"
        anchor={anchor ?? undefined}
        {...popper({ side, align, sideOffset, collisionPadding })}
      >
        <PopoverPrimitive.Popup
          {...usePortalScopeProps()}
          id={id}
          initialFocus={autoFocusRef ? false : autoFocus(onOpenAutoFocus)}
          finalFocus={() =>
            returnFocus() &&
            anchor === null &&
            !(modal ? press?.current.right : press?.current.outside)
          }
          onPointerDownCapture={() => {
            if (press) press.current.inside = true;
          }}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            if (!modal) loopTabFocus(event);
          }}
          className={cn(
            "w-96 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95",
            className,
          )}
          {...props}
        >
          {children}
          {modal ? <ModalParts /> : null}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
