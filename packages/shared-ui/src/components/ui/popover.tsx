import * as React from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useRender } from "@base-ui/react/use-render";

import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "../../lib/portal-scope";
import { usePointerCoarse } from "./hooks/use-pointer-coarse.js";
import { useLayer, useModalLayer, type OverlayLayer } from "./overlay-layer.js";
import {
  COMPACT_SHEET_CONTENT_STYLE,
  MobileTrigger,
  ResponsiveDrawerShell,
  useResponsiveRoot,
} from "./responsive-overlay.js";
import {
  autoFocus,
  focusAfterClose,
  loopTabFocus,
  overlayTriggerProps,
  popper,
  PORTAL_CLASS,
  slot,
  useOverlayOpen,
  type PopperProps,
} from "./overlay-trigger.js";

const PopoverContext = React.createContext<{
  id?: string;
  open: boolean;
  modal: boolean;
  layer: OverlayLayer | null;
  triggerRef: React.RefObject<HTMLButtonElement | null> | null;
  anchor: Element | null;
  setAnchor: (anchor: Element | null) => void;
  isCompactViewport?: boolean;
  onOpenChange?: (open: boolean) => void;
}>({
  open: false,
  modal: false,
  layer: null,
  triggerRef: null,
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
  const ctx = useResponsiveRoot(open, onOpenChange, defaultOpen);

  if (ctx.isCompactViewport) {
    return (
      <PopoverContext.Provider
        value={{
          ...ctx,
          modal,
          layer: null,
          triggerRef: null,
          anchor: null,
          setAnchor: () => {},
        }}
      >
        {children}
      </PopoverContext.Provider>
    );
  }

  return (
    <FloatingPopover
      open={ctx.open}
      onOpenChange={ctx.onOpenChange}
      modal={modal}
    >
      {children}
    </FloatingPopover>
  );
}

function FloatingPopover({
  children,
  open,
  onOpenChange,
  modal,
}: {
  children?: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modal: boolean;
}) {
  const state = useOverlayOpen(open, onOpenChange);
  const id = React.useId();
  const layer = useLayer(state.open, modal, id, () =>
    state.onOpenChange(false),
  );
  const [anchor, setAnchor] = React.useState<Element | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  return (
    <PopoverPrimitive.Root
      actionsRef={layer.actionsRef}
      open={state.open}
      onOpenChange={(next, details) => {
        if (layer.ignores(details)) return;
        const { reason } = details;
        layer.press.current.outside =
          reason === "outside-press" ||
          reason === "focus-out" ||
          reason === "trigger-press";
        state.onOpenChange(next);
      }}
      modal={modal}
    >
      <PopoverContext.Provider
        value={{
          id,
          open: state.open,
          modal,
          layer,
          triggerRef,
          anchor,
          setAnchor,
        }}
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
  const { open, layer, triggerRef, isCompactViewport, onOpenChange } =
    React.useContext(PopoverContext);

  if (isCompactViewport && onOpenChange) {
    return (
      <MobileTrigger
        open={open}
        onOpenChange={onOpenChange}
        haspopup="dialog"
        className={className}
        {...props}
      />
    );
  }

  return (
    <PopoverPrimitive.Trigger
      ref={triggerRef}
      data-state={open ? "open" : "closed"}
      onPointerDownCapture={layer?.markPressInside}
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
  const { setAnchor, isCompactViewport } = React.useContext(PopoverContext);
  return useRender({
    render: children,
    ref: isCompactViewport ? undefined : setAnchor,
  });
}

function ModalParts() {
  const { id, open, layer } = React.useContext(PopoverContext);
  useModalLayer(id, open, "popover", layer);
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
  mobileTitle,
  mobileClassName,
  onMobileContentAnimationEnd,
  children,
  ...props
}: Omit<React.ComponentProps<typeof PopoverPrimitive.Popup>, "className"> &
  PopperProps & {
    className?: string;
    autoFocusRef?: React.RefObject<HTMLElement | null>;
    onOpenAutoFocus?: (event: Event) => void;
    onCloseAutoFocus?: (event: Event) => void;
    mobileTitle?: string;
    mobileClassName?: string;
    onMobileContentAnimationEnd?: (open: boolean) => void;
  }) {
  const {
    id,
    open,
    modal,
    layer,
    triggerRef,
    anchor,
    isCompactViewport,
    onOpenChange,
  } = React.useContext(PopoverContext);
  const isPointerCoarse = usePointerCoarse();
  const press = layer?.press.current;
  const scopeProps = usePortalScopeProps();

  React.useEffect(() => {
    if (!open || isCompactViewport || isPointerCoarse || !autoFocusRef) return;
    const frame = window.requestAnimationFrame(() => {
      const target = autoFocusRef.current;
      target?.focus();
      if (target instanceof HTMLInputElement) target.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocusRef, isCompactViewport, isPointerCoarse, open]);

  if (isCompactViewport && onOpenChange) {
    const {
      initialFocus: _initialFocus,
      finalFocus: _finalFocus,
      style,
      ...domProps
    } = props;
    return (
      <ResponsiveDrawerShell
        open={open}
        onOpenChange={onOpenChange}
        srLabel={mobileTitle ?? "Options"}
        contentClassName={mobileClassName}
        onContentAnimationEnd={onMobileContentAnimationEnd}
      >
        <div
          className={cn("overflow-y-auto px-4 pt-2 pb-4", className)}
          {...(domProps as React.ComponentProps<"div">)}
          style={{
            ...(style as React.CSSProperties | undefined),
            ...COMPACT_SHEET_CONTENT_STYLE,
          }}
        >
          {children}
        </div>
      </ResponsiveDrawerShell>
    );
  }

  return (
    <PopoverPrimitive.Portal className={PORTAL_CLASS}>
      <PopoverPrimitive.Positioner
        className="z-50"
        anchor={anchor ?? undefined}
        {...popper({ side, align, sideOffset, collisionPadding })}
      >
        <PopoverPrimitive.Popup
          {...scopeProps}
          id={id}
          initialFocus={
            isPointerCoarse || autoFocusRef ? false : autoFocus(onOpenAutoFocus)
          }
          finalFocus={focusAfterClose(
            onCloseAutoFocus,
            () =>
              !(modal ? press?.right : press?.outside) && triggerRef?.current,
          )}
          onPointerDownCapture={layer?.markPressInside}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            loopTabFocus(event);
          }}
          className={cn(
            "w-96 rounded-[calc(var(--radius)+2px)] border border-border-raised bg-popover p-4 text-popover-foreground shadow-md outline-none data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95",
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
