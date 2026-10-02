import * as React from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";

import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "../../lib/portal-scope";
import {
  isLastInputKeyboard,
  overlayTriggerProps,
  useOverlayOpen,
} from "./overlay-trigger.js";
import {
  MENU_ITEM_LAST_HOVERED_CLASS,
  MenuHoverProvider,
  useMenuItemHover,
} from "./menu-item-hover.js";
import { LIST_HOVER_TRANSITION } from "./motion.js";
import { Icon } from "../../components/ui/icon.js";

const CONTENT_CLASS =
  "z-50 min-w-28 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2";

const MenuOpenContext = React.createContext(false);

function DropdownMenu({
  children,
  open,
  onOpenChange,
  defaultOpen,
  ...props
}: React.ComponentProps<typeof Menu.Root>) {
  const state = useOverlayOpen(open, onOpenChange, defaultOpen);
  return (
    <Menu.Root {...state} {...props}>
      <MenuOpenContext.Provider value={state.open}>
        {children}
      </MenuOpenContext.Provider>
    </Menu.Root>
  );
}

function DropdownMenuTrigger({
  className,
  ...props
}: React.ComponentProps<typeof Menu.Trigger>) {
  const open = React.useContext(MenuOpenContext);
  return <Menu.Trigger {...overlayTriggerProps(open, className)} {...props} />;
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  children,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        {...usePortalScopeProps()}
        sideOffset={sideOffset}
        onCloseAutoFocus={(event) => {
          const focusTaken =
            document.activeElement !== null &&
            document.activeElement !== document.body;
          if (!isLastInputKeyboard() || focusTaken) {
            event.preventDefault();
          }
          onCloseAutoFocus?.(event);
        }}
        className={cn(CONTENT_CLASS, className)}
        {...props}
      >
        <MenuHoverProvider>{children}</MenuHoverProvider>
      </Menu.Content>
    </Menu.Portal>
  );
}

function DropdownMenuItem({
  className,
  variant,
  onPointerMove,
  onPointerLeave,
  ...props
}: React.ComponentProps<typeof Menu.Item> & {
  variant?: "default" | "destructive";
}) {
  const open = React.useContext(MenuOpenContext);
  const keepFocusWhileClosing =
    (handler: React.PointerEventHandler<HTMLDivElement> | undefined) =>
    (event: React.PointerEvent<HTMLDivElement>) => {
      handler?.(event);
      if (!open) event.preventDefault();
    };
  return (
    <Menu.Item
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-[0.3125rem] text-xs outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&>[data-icon-root]]:size-4 [&>[data-icon-root]]:shrink-0",
        LIST_HOVER_TRANSITION,
        variant === "destructive"
          ? "text-destructive focus:bg-destructive/15 focus:text-destructive data-[last-hovered]:bg-destructive/15"
          : `focus:bg-state-hover focus:text-foreground ${MENU_ITEM_LAST_HOVERED_CLASS}`,
        className,
      )}
      onPointerMove={keepFocusWhileClosing(onPointerMove)}
      onPointerLeave={keepFocusWhileClosing(onPointerLeave)}
      {...props}
      {...useMenuItemHover(props).hoverProps}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Menu.CheckboxItem>) {
  return (
    <Menu.CheckboxItem
      className={cn(
        "relative flex cursor-default select-none items-center rounded-sm py-[0.3125rem] pl-2 pr-8 text-xs outline-none focus:bg-state-hover focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        LIST_HOVER_TRANSITION,
        MENU_ITEM_LAST_HOVERED_CLASS,
        className,
      )}
      {...props}
      {...useMenuItemHover(props).hoverProps}
    >
      <span className="absolute right-2 flex items-center justify-center h-3.5 w-3.5">
        <Menu.ItemIndicator>
          <Icon name="Check" className="h-3.5 w-3.5" />
        </Menu.ItemIndicator>
      </span>
      {children}
    </Menu.CheckboxItem>
  );
}

function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof Menu.Label>) {
  return (
    <Menu.Label
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
}: React.ComponentProps<typeof Menu.Separator>) {
  return (
    <Menu.Separator
      className={cn("-mx-1 my-1 h-px bg-muted", className)}
      {...props}
    />
  );
}

function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Menu.SubTrigger>) {
  return (
    <Menu.SubTrigger
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
    </Menu.SubTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof Menu.SubContent>) {
  return (
    <Menu.SubContent
      {...usePortalScopeProps()}
      className={cn(CONTENT_CLASS, className)}
      {...props}
    />
  );
}

const DropdownMenuGroup = Menu.Group;
const DropdownMenuPortal = Menu.Portal;
const DropdownMenuSub = Menu.Sub;

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
