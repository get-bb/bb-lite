import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "@bb/shared-ui/lib/utils";
import { Button } from "@bb/shared-ui/button";
import { COARSE_POINTER_HEADER_ICON_BUTTON_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon } from "@bb/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";

const SIDEBAR_WIDTH = "16rem";

type SidebarContext = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContext | null>(null);

const SidebarWidthContext = React.createContext<string>(SIDEBAR_WIDTH);

const SidebarShowingContext = React.createContext<boolean | null>(null);

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }

  return context;
}

function useIsSidebarShowing(): boolean {
  const isShowing = React.useContext(SidebarShowingContext);
  if (isShowing === null) {
    throw new Error(
      "useIsSidebarShowing must be used within a SidebarProvider.",
    );
  }
  return isShowing;
}

function useOptionalIsSidebarShowing(): boolean | null {
  return React.useContext(SidebarShowingContext);
}

const SidebarProvider = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & {
    defaultOpen?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    width?: string;
  }
>(
  (
    {
      defaultOpen = true,
      open: openProp,
      onOpenChange: setOpenProp,
      width = SIDEBAR_WIDTH,
      className,
      style,
      children,
      ...props
    },
    ref,
  ) => {
    const [_open, _setOpen] = React.useState(defaultOpen);
    const open = openProp ?? _open;
    const setOpen = React.useCallback(
      (value: boolean | ((value: boolean) => boolean)) => {
        const openState = typeof value === "function" ? value(open) : value;
        if (setOpenProp) {
          setOpenProp(openState);
        } else {
          _setOpen(openState);
        }
      },
      [setOpenProp, open],
    );

    const toggleSidebar = React.useCallback(() => {
      setOpen((open) => !open);
    }, [setOpen]);

    const state = open ? "expanded" : "collapsed";

    const contextValue = React.useMemo<SidebarContext>(
      () => ({
        state,
        open,
        setOpen,
        toggleSidebar,
      }),
      [state, open, setOpen, toggleSidebar],
    );

    return (
      <SidebarContext.Provider value={contextValue}>
        <SidebarShowingContext.Provider value={open}>
          <SidebarWidthContext.Provider value={width}>
            {}
            <div
              style={style}
              className={cn(
                "group/sidebar-wrapper flex h-full min-h-0 w-full",
                className,
              )}
              ref={ref}
              {...props}
            >
              {children}
            </div>
          </SidebarWidthContext.Provider>
        </SidebarShowingContext.Provider>
      </SidebarContext.Provider>
    );
  },
);
SidebarProvider.displayName = "SidebarProvider";

const Sidebar = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  ({ className, style, children, ...props }, ref) => {
    const { state } = useSidebar();
    const width = React.useContext(SidebarWidthContext);
    const widthStyle = { "--sidebar-width": width } as React.CSSProperties;

    return (
      <div
        ref={ref}
        className="group peer text-sidebar-foreground"
        data-state={state}
        data-collapsible={state === "collapsed" ? "offcanvas" : ""}
        data-variant="sidebar"
        data-side="left"
      >
        {}
        <div
          data-sidebar="gap"
          style={widthStyle}
          className={cn(
            "relative hidden h-full w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear md:block",
            "group-data-[collapsible=offcanvas]:w-0",
          )}
        />
        <div
          data-sidebar="panel"
          className={cn(
            "fixed inset-y-0 z-10 flex h-(--bb-shell-height) w-(--sidebar-width) select-none flex-col bg-sidebar text-sidebar-foreground [transition:left_200ms_linear,right_200ms_linear,width_200ms_linear,visibility_0s_linear_0s]",
            "group-data-[collapsible=offcanvas]:invisible group-data-[collapsible=offcanvas]:[transition:left_200ms_linear,right_200ms_linear,width_200ms_linear,visibility_0s_linear_200ms]",
            "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]",
            "border-border-seam group-data-[side=left]:border-r",
            className,
          )}
          style={{ ...widthStyle, ...style }}
          {...props}
        >
          <div
            data-sidebar="sidebar"
            className="flex h-full w-full flex-col bg-sidebar"
          >
            {children}
          </div>
        </div>
      </div>
    );
  },
);
Sidebar.displayName = "Sidebar";

const SidebarTrigger = React.forwardRef<
  React.ComponentRef<typeof Button>,
  React.ComponentProps<typeof Button>
>(({ className, onClick, "aria-expanded": ariaExpanded, ...props }, ref) => {
  const { open, toggleSidebar } = useSidebar();

  return (
    <Button
      ref={ref}
      data-sidebar="trigger"
      variant="ghost"
      size="icon"
      className={cn(
        COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
        "select-none",
        className,
      )}
      aria-expanded={ariaExpanded ?? open}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      {...props}
    >
      <Icon name="PanelLeft" />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  );
});
SidebarTrigger.displayName = "SidebarTrigger";

const SidebarInset = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"main">
>(({ className, ...props }, ref) => {
  return (
    <main
      ref={ref}
      data-sidebar="inset"
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background",
        "motion-reduce:transition-none!",
        className,
      )}
      {...props}
    />
  );
});
SidebarInset.displayName = "SidebarInset";

const SidebarFooter = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      data-sidebar="footer"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  );
});
SidebarFooter.displayName = "SidebarFooter";

const SidebarContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      data-sidebar="content"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-2 overflow-auto bg-sidebar",
        className,
      )}
      {...props}
    />
  );
});
SidebarContent.displayName = "SidebarContent";

const SidebarMenu = React.forwardRef<
  HTMLUListElement,
  React.ComponentProps<"ul">
>(({ className, ...props }, ref) => (
  <ul
    ref={ref}
    data-sidebar="menu"
    className={cn("flex w-full min-w-0 flex-col gap-1", className)}
    {...props}
  />
));
SidebarMenu.displayName = "SidebarMenu";

const SidebarMenuItem = React.forwardRef<
  HTMLLIElement,
  React.ComponentProps<"li">
>(({ className, ...props }, ref) => (
  <li
    ref={ref}
    data-sidebar="menu-item"
    className={cn("group/menu-item relative", className)}
    {...props}
  />
));
SidebarMenuItem.displayName = "SidebarMenuItem";

const SIDEBAR_MENU_BUTTON_CLASS =
  "flex h-8 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-none ring-sidebar-ring transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>[data-icon-root]]:size-4 [&>[data-icon-root]]:shrink-0";

const SidebarMenuButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & {
    asChild?: boolean;
    tooltip?: React.ComponentProps<typeof TooltipContent>;
  }
>(({ asChild = false, tooltip, className, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  const { state } = useSidebar();

  const button = (
    <Comp
      ref={ref}
      data-sidebar="menu-button"
      className={cn(SIDEBAR_MENU_BUTTON_CLASS, className)}
      {...props}
    />
  );

  if (!tooltip) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent
        side="right"
        align="center"
        hidden={state !== "collapsed"}
        {...tooltip}
      />
    </Tooltip>
  );
});
SidebarMenuButton.displayName = "SidebarMenuButton";

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useIsSidebarShowing,
  useOptionalIsSidebarShowing,
};
