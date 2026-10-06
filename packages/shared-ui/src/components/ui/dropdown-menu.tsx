import * as React from "react";
import { Menu } from "@base-ui/react/menu";

import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "../../lib/portal-scope";
import { COARSE_POINTER_CHECK_SLOT_CLASS } from "./coarse-pointer-sizing.js";
import { useLayer, useModalLayer, type OverlayLayer } from "./overlay-layer.js";
import {
  COMPACT_SHEET_CONTENT_STYLE,
  MobileTrigger,
  ResponsiveDrawerShell,
  useResponsiveRoot,
} from "./responsive-overlay.js";
import {
  focusAfterClose,
  isLastInputKeyboard,
  overlayTriggerProps,
  popper,
  PORTAL_CLASS,
  slot,
  useOverlayOpen,
  type PopperProps,
} from "./overlay-trigger.js";
import {
  MENU_ITEM_LAST_HOVERED_CLASS,
  MenuHoverProvider,
  useMenuItemHover,
} from "./menu-item-hover.js";
import { LIST_HOVER_TRANSITION } from "./motion.js";
import { Icon } from "../../components/ui/icon.js";

const POPUP_CLASS =
  "min-w-28 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2";
const ITEM_CLASS =
  "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-[0.3125rem] text-xs outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&>[data-icon-root]]:size-4 [&>[data-icon-root]]:shrink-0";
const ITEM_FOCUS_CLASS = `focus:bg-state-hover focus:text-foreground ${MENU_ITEM_LAST_HOVERED_CLASS}`;
const COMPACT_ITEM_STATE_CLASS =
  "outline-none transition-colors focus:bg-state-hover focus:text-foreground active:bg-state-active active:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

export const MenuContext = React.createContext<{
  id?: string;
  open: boolean;
  modal: boolean;
  context: boolean;
  returnTo: React.RefObject<Element | null> | null;
  layer: OverlayLayer | null;
  isCompactViewport?: boolean;
  onOpenChange?: (open: boolean) => void;
}>({
  open: false,
  modal: false,
  context: false,
  returnTo: null,
  layer: null,
});

export function useMenuRoot(
  open: boolean | undefined,
  onOpenChange: ((open: boolean) => void) | undefined,
  defaultOpen: boolean | undefined,
  modal: boolean,
  onRootOpenChange?: (
    open: boolean,
    reason: string,
    returnTo: React.RefObject<Element | null>,
  ) => void,
) {
  const state = useOverlayOpen(open, onOpenChange, defaultOpen);
  const id = React.useId();
  const returnTo = React.useRef<Element | null>(null);
  const layer = useLayer(state.open, modal, id);
  return {
    id,
    open: state.open,
    returnTo,
    layer,
    rootProps: {
      actionsRef: layer.actionsRef,
      open: state.open,
      onOpenChange: (
        next: boolean,
        details: Parameters<typeof layer.ignores>[0],
      ) => {
        if (layer.ignores(details)) return;
        onRootOpenChange?.(next, details.reason, returnTo);
        state.onOpenChange(next);
      },
      loopFocus: false,
    },
  };
}

function DropdownMenu({
  children,
  open,
  onOpenChange,
  defaultOpen,
  modal = true,
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
      <MenuContext.Provider
        value={{
          ...ctx,
          modal,
          context: false,
          returnTo: null,
          layer: null,
        }}
      >
        {children}
      </MenuContext.Provider>
    );
  }

  return (
    <FloatingDropdownMenu
      open={ctx.open}
      onOpenChange={ctx.onOpenChange}
      modal={modal}
    >
      {children}
    </FloatingDropdownMenu>
  );
}

function FloatingDropdownMenu({
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
  const root = useMenuRoot(open, onOpenChange, false, modal);
  return (
    <Menu.Root {...root.rootProps} modal={modal}>
      <MenuContext.Provider
        value={{
          id: root.id,
          open: root.open,
          modal,
          context: false,
          returnTo: root.returnTo,
          layer: root.layer,
        }}
      >
        {children}
      </MenuContext.Provider>
    </Menu.Root>
  );
}

function DropdownMenuTrigger({
  className,
  ...props
}: {
  asChild?: boolean;
  disabled?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  const { open, returnTo, isCompactViewport, onOpenChange } =
    React.useContext(MenuContext);

  if (isCompactViewport && onOpenChange) {
    return (
      <MobileTrigger
        open={open}
        onOpenChange={onOpenChange}
        haspopup="menu"
        className={className}
        {...props}
      />
    );
  }

  return (
    <Menu.Trigger
      ref={returnTo as React.RefObject<HTMLButtonElement | null>}
      data-state={open ? "open" : "closed"}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp") event.preventBaseUIHandler();
      }}
      {...overlayTriggerProps(open, className)}
      {...slot(props)}
    />
  );
}

function ModalLayer() {
  const { id, open, layer } = React.useContext(MenuContext);
  useModalLayer(id, open, "menu", layer);
  return null;
}

export function MenuPopup({
  className,
  children,
  side,
  align,
  sideOffset,
  alignOffset,
  collisionPadding,
  ...props
}: Omit<React.ComponentProps<typeof Menu.Popup>, "className"> &
  PopperProps & { className?: string }) {
  const { id, modal, context } = React.useContext(MenuContext);
  return (
    <Menu.Portal className={PORTAL_CLASS}>
      <Menu.Positioner
        className={context ? "z-[70]" : "z-50"}
        {...popper({ side, align, sideOffset, alignOffset, collisionPadding })}
      >
        <Menu.Popup
          {...usePortalScopeProps()}
          id={id}
          aria-orientation="vertical"
          className={cn(
            POPUP_CLASS,
            !context && "data-open:zoom-in-95",
            className,
          )}
          {...props}
          onKeyDown={(event) => {
            props.onKeyDown?.(event);
            if (!event.currentTarget.contains(event.target as Node)) return;
            const jump = { PageUp: "Home", PageDown: "End" }[event.key];
            if (event.key === "Tab") {
              event.preventDefault();
              event.preventBaseUIHandler();
            } else if (jump) {
              event.preventDefault();
              event.target.dispatchEvent(
                new KeyboardEvent("keydown", { key: jump, bubbles: true }),
              );
            }
          }}
        >
          {children}
          {modal ? <ModalLayer /> : null}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}

function DropdownMenuContent({
  sideOffset = 4,
  onCloseAutoFocus,
  mobileTitle,
  children,
  ...props
}: React.ComponentProps<typeof MenuPopup> & {
  onCloseAutoFocus?: (event: Event) => void;
  mobileTitle?: string;
}) {
  const { open, returnTo, isCompactViewport, onOpenChange } =
    React.useContext(MenuContext);

  if (isCompactViewport && onOpenChange) {
    const {
      side: _side,
      align: _align,
      alignOffset: _alignOffset,
      collisionPadding: _collisionPadding,
      finalFocus: _finalFocus,
      className,
      style,
      ...domProps
    } = props;
    return (
      <ResponsiveDrawerShell
        open={open}
        onOpenChange={onOpenChange}
        srLabel={mobileTitle ?? "Menu"}
      >
        <div
          className={cn("flex flex-col gap-0.5 overflow-y-auto p-2", className)}
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
    <MenuPopup
      sideOffset={sideOffset}
      finalFocus={focusAfterClose(
        (event) => {
          const active = document.activeElement;
          const focusTaken = active !== null && active !== document.body;
          if (!isLastInputKeyboard() || focusTaken) event.preventDefault();
          onCloseAutoFocus?.(event);
        },
        () => returnTo?.current,
      )}
      {...props}
    >
      <MenuHoverProvider>{children}</MenuHoverProvider>
    </MenuPopup>
  );
}

function MenuItemBase({
  onSelect,
  textValue,
  disabled,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Menu.Item>, "className" | "onSelect"> & {
  className?: string;
  onSelect?: (event: Event) => void;
  textValue?: string;
}) {
  const { context, isCompactViewport, onOpenChange } =
    React.useContext(MenuContext);
  const { hoverProps } = useMenuItemHover(props);
  if (isCompactViewport) {
    return (
      <button
        ref={props.ref as React.Ref<HTMLButtonElement>}
        type="button"
        role={props.role ?? "menuitem"}
        disabled={disabled}
        aria-disabled={disabled || undefined}
        aria-checked={props["aria-checked"]}
        className={props.className}
        data-disabled={disabled ? "" : undefined}
        onFocus={props.onFocus as React.FocusEventHandler<HTMLElement>}
        onBlur={props.onBlur as React.FocusEventHandler<HTMLElement>}
        onClick={() => {
          if (disabled) return;
          const select = new Event("select", { cancelable: true });
          onSelect?.(select);
          if (!select.defaultPrevented) onOpenChange?.(false);
        }}
      >
        {children}
      </button>
    );
  }
  if (disabled) {
    return (
      <div
        role="menuitem"
        aria-disabled="true"
        data-disabled=""
        tabIndex={-1}
        {...(props as React.ComponentProps<"div">)}
      >
        {children}
      </div>
    );
  }
  return (
    <Menu.Item
      label={textValue}
      {...props}
      {...hoverProps}
      onClick={(event) => {
        props.onClick?.(event);
        const select = new Event("select", { cancelable: true });
        onSelect?.(select);
        if (select.defaultPrevented) event.preventBaseUIHandler();
      }}
      onMouseUp={(event) => {
        props.onMouseUp?.(event);
        if (context && event.button !== 0) event.preventBaseUIHandler();
      }}
    >
      {children}
    </Menu.Item>
  );
}

function DropdownMenuItem({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof MenuItemBase> & {
  variant?: "default" | "destructive";
}) {
  const { isCompactViewport } = React.useContext(MenuContext);
  if (isCompactViewport) {
    return (
      <MenuItemBase
        className={cn(
          "relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-2 text-left text-xs [&>[data-icon-root]]:size-4 [&>[data-icon-root]]:shrink-0",
          COMPACT_ITEM_STATE_CLASS,
          variant === "destructive" &&
            "text-destructive focus:bg-destructive/15 focus:text-destructive active:bg-destructive/20 active:text-destructive",
          className,
        )}
        {...props}
      />
    );
  }
  return (
    <MenuItemBase
      className={cn(
        ITEM_CLASS,
        LIST_HOVER_TRANSITION,
        variant === "destructive"
          ? "text-destructive focus:bg-destructive/15 focus:text-destructive data-[last-hovered]:bg-destructive/15"
          : ITEM_FOCUS_CLASS,
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  onCheckedChange,
  onSelect,
  ...props
}: React.ComponentProps<typeof MenuItemBase> & {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}) {
  const { isCompactViewport } = React.useContext(MenuContext);
  return (
    <MenuItemBase
      role="menuitemcheckbox"
      aria-checked={checked}
      className={
        isCompactViewport
          ? cn(
              "relative flex w-full cursor-default select-none items-center rounded-sm py-2 pl-2 pr-8 text-left text-xs",
              COMPACT_ITEM_STATE_CLASS,
              className,
            )
          : cn(
              "relative flex cursor-default select-none items-center rounded-sm py-[0.3125rem] pl-2 pr-8 text-xs outline-none focus:bg-state-hover focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
              LIST_HOVER_TRANSITION,
              MENU_ITEM_LAST_HOVERED_CLASS,
              className,
            )
      }
      onSelect={(event) => {
        onSelect?.(event);
        onCheckedChange?.(!checked);
      }}
      {...props}
    >
      <span
        className={cn(
          "absolute right-2 flex items-center justify-center",
          COARSE_POINTER_CHECK_SLOT_CLASS,
        )}
      >
        {checked && isCompactViewport ? (
          <Icon name="Check" className={COARSE_POINTER_CHECK_SLOT_CLASS} />
        ) : checked ? (
          <span>
            <Icon name="Check" className={COARSE_POINTER_CHECK_SLOT_CLASS} />
          </span>
        ) : null}
      </span>
      {children}
    </MenuItemBase>
  );
}

function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const { isCompactViewport } = React.useContext(MenuContext);
  if (isCompactViewport) {
    return (
      <div
        ref={props.ref}
        className={cn(
          "px-2 py-1.5 text-xs font-medium text-muted-foreground",
          className,
        )}
      >
        {props.children}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "px-2 py-[0.3125rem] text-xs font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const { isCompactViewport } = React.useContext(MenuContext);
  if (isCompactViewport) {
    return (
      <hr className={cn("-mx-1 my-1 h-px border-0 bg-muted", className)} />
    );
  }
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      className={cn("-mx-1 my-1 h-px bg-muted", className)}
      {...props}
    />
  );
}

function DropdownMenuGroup(props: React.ComponentProps<"div">) {
  return <div role="group" {...props} />;
}

function DropdownMenuPortal({ children }: { children?: React.ReactNode }) {
  return children;
}

function DropdownMenuSub({ children }: { children?: React.ReactNode }) {
  const { context, layer, isCompactViewport } = React.useContext(MenuContext);
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  if (isCompactViewport) return null;
  return (
    <Menu.SubmenuRoot
      onOpenChange={(next, details) => {
        if (!layer?.ignores(details)) setOpen(next);
      }}
      loopFocus={false}
      closeParentOnEsc
    >
      <MenuContext.Provider
        value={{ id, open, modal: false, context, returnTo: null, layer }}
      >
        {children}
      </MenuContext.Provider>
    </Menu.SubmenuRoot>
  );
}

function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Menu.SubmenuTrigger>, "className"> & {
  className?: string;
}) {
  const { open } = React.useContext(MenuContext);
  return (
    <Menu.SubmenuTrigger
      data-state={open ? "open" : "closed"}
      className={cn(
        "flex cursor-default gap-2 select-none items-center rounded-sm px-2 py-[0.3125rem] text-xs outline-none focus:bg-state-hover focus:text-foreground data-[state=open]:bg-state-active data-[state=open]:text-foreground [&_[data-icon-root]]:pointer-events-none [&_[data-icon-root]]:size-4 [&_[data-icon-root]]:shrink-0",
        LIST_HOVER_TRANSITION,
        MENU_ITEM_LAST_HOVERED_CLASS,
        className,
      )}
      {...props}
      {...useMenuItemHover(props).hoverProps}
    >
      {children}
      <Icon name="ChevronRight" className="ml-auto" />
    </Menu.SubmenuTrigger>
  );
}

function DropdownMenuSubContent(props: React.ComponentProps<typeof MenuPopup>) {
  return <MenuPopup side="right" align="start" finalFocus={false} {...props} />;
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
};
