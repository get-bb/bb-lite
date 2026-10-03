import * as React from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";

import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "../../lib/portal-scope";
import { useLayer, useModalLayer, type OverlayLayer } from "./overlay-layer.js";
import { focusAfterClose, popper, PORTAL_CLASS } from "./overlay-trigger.js";
import { CONTROL_HOVER_TRANSITION } from "./motion.js";
import { Icon } from "../../components/ui/icon.js";

const SCROLL_BUTTON_CLASS =
  "flex cursor-default items-center justify-center py-1";

const SelectContext = React.createContext<{
  id?: string;
  open: boolean;
  layer: OverlayLayer | null;
  triggerRef: React.RefObject<HTMLButtonElement | null> | null;
}>({ open: false, layer: null, triggerRef: null });

function Select({
  value,
  onValueChange,
  children,
}: {
  value?: string;
  onValueChange?: (value: string) => void;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  const layer = useLayer(open, true, id);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  return (
    <SelectPrimitive.Root
      value={value ?? null}
      onValueChange={(next) => {
        if (next !== null) onValueChange?.(next);
      }}
      open={open}
      onOpenChange={(next, details) => {
        if (!layer.ignores(details)) setOpen(next);
      }}
    >
      <SelectContext.Provider value={{ id, open, layer, triggerRef }}>
        {children}
      </SelectContext.Provider>
    </SelectPrimitive.Root>
  );
}

function SelectValue({
  placeholder,
  children,
}: {
  placeholder?: string;
  children?: React.ReactNode;
}) {
  return (
    <SelectPrimitive.Value className="pointer-events-none">
      {(value: string | null) =>
        value === null || value === "" ? placeholder : children
      }
    </SelectPrimitive.Value>
  );
}

function SelectTrigger({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.Trigger>, "className"> & {
  className?: string;
}) {
  const { open, triggerRef } = React.useContext(SelectContext);
  return (
    <SelectPrimitive.Trigger
      ref={triggerRef}
      aria-autocomplete="none"
      data-state={open ? "open" : "closed"}
      className={cn(
        `flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm ${CONTROL_HOVER_TRANSITION} placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1`,
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={<Icon name="ChevronDown" className="size-4 opacity-50" />}
      />
    </SelectPrimitive.Trigger>
  );
}

function ModalLayer() {
  const { id, open, layer } = React.useContext(SelectContext);
  useModalLayer(id, open, "select", layer);
  return null;
}

function SelectContent({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const { id, open, triggerRef } = React.useContext(SelectContext);
  return (
    <SelectPrimitive.Portal className={PORTAL_CLASS}>
      <SelectPrimitive.Positioner
        className="z-50"
        alignItemWithTrigger={false}
        {...popper({ side: "bottom", align: "start", collisionPadding: 10 })}
      >
        <SelectPrimitive.Popup
          {...usePortalScopeProps()}
          id={id}
          finalFocus={focusAfterClose(undefined, () => triggerRef?.current)}
          onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            event.preventDefault();
            event.preventBaseUIHandler();
          }}
          className={cn(
            "relative flex max-h-96 min-w-[8rem] flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md outline-none data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
            className,
          )}
        >
          <SelectPrimitive.ScrollUpArrow className={SCROLL_BUTTON_CLASS}>
            <Icon name="ChevronUp" className="size-4" />
          </SelectPrimitive.ScrollUpArrow>
          <SelectPrimitive.List className="relative w-full min-w-[var(--anchor-width)] flex-1 overflow-x-hidden overflow-y-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {children}
          </SelectPrimitive.List>
          <SelectPrimitive.ScrollDownArrow className={SCROLL_BUTTON_CLASS}>
            <Icon name="ChevronDown" className="size-4" />
          </SelectPrimitive.ScrollDownArrow>
          {open ? <ModalLayer /> : null}
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.Item>, "className"> & {
  className?: string;
}) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none focus:bg-state-hover focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator aria-hidden>
          <Icon name="Check" className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText render={<span />}>
        {children}
      </SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectValue, SelectTrigger, SelectContent, SelectItem };
