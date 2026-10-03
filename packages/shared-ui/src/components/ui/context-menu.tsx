import * as React from "react";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";

import { focusAfterClose, slot } from "./overlay-trigger.js";
import { MenuContext, MenuPopup, useMenuRoot } from "./dropdown-menu.js";
import { MenuHoverProvider } from "./menu-item-hover.js";

function ContextMenu({
  children,
  open,
  onOpenChange,
  modal = true,
  disabled,
}: {
  children?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  disabled?: boolean;
}) {
  const root = useMenuRoot(
    open,
    onOpenChange,
    false,
    modal,
    (next, reason, returnTo) => {
      const outside = reason === "outside-press" || reason === "focus-out";
      if (next) returnTo.current = document.activeElement;
      else if (!modal && outside) returnTo.current = null;
    },
  );
  return (
    <ContextMenuPrimitive.Root {...root.rootProps} disabled={disabled}>
      <MenuContext.Provider
        value={{
          id: root.id,
          open: root.open,
          modal,
          context: true,
          returnTo: root.returnTo,
          layer: root.layer,
        }}
      >
        {children}
      </MenuContext.Provider>
    </ContextMenuPrimitive.Root>
  );
}

function ContextMenuTrigger(props: {
  asChild?: boolean;
  children?: React.ReactNode;
}) {
  const { open } = React.useContext(MenuContext);
  return (
    <ContextMenuPrimitive.Trigger
      data-state={open ? "open" : "closed"}
      {...slot(props)}
    />
  );
}

function ContextMenuContent({
  onCloseAutoFocus,
  children,
  ...props
}: React.ComponentProps<typeof MenuPopup> & {
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { returnTo } = React.useContext(MenuContext);
  return (
    <MenuPopup
      side="right"
      align="start"
      sideOffset={2}
      finalFocus={focusAfterClose(onCloseAutoFocus, () => returnTo?.current)}
      {...props}
    >
      <MenuHoverProvider>{children}</MenuHoverProvider>
    </MenuPopup>
  );
}

export { ContextMenu, ContextMenuTrigger, ContextMenuContent };
export {
  DropdownMenuItem as ContextMenuItem,
  DropdownMenuSeparator as ContextMenuSeparator,
  DropdownMenuSub as ContextMenuSub,
  DropdownMenuSubContent as ContextMenuSubContent,
  DropdownMenuSubTrigger as ContextMenuSubTrigger,
} from "./dropdown-menu.js";
