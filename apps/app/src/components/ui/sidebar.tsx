import * as React from "react";

import { cn } from "@bb/shared-ui/lib/utils";
import { Button, Slot } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";

const SidebarContext = React.createContext<{
  open: boolean;
  toggleSidebar: () => void;
} | null>(null);

const SidebarWidthContext = React.createContext("16rem");

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }
  return context;
}

function useIsSidebarShowing(): boolean {
  return useSidebar().open;
}

function SidebarProvider({
  open,
  onOpenChange,
  width,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  width: string;
}) {
  const toggleSidebar = () => onOpenChange(!open);
  return (
    <SidebarContext.Provider value={{ open, toggleSidebar }}>
      <SidebarWidthContext.Provider value={width}>
        <div
          className={cn(
            "group/sidebar-wrapper flex h-full min-h-0 w-full",
            className,
          )}
          {...props}
        >
          {children}
        </div>
      </SidebarWidthContext.Provider>
    </SidebarContext.Provider>
  );
}

function Sidebar({
  ref,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const state = useSidebar().open ? "expanded" : "collapsed";
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
}

function SidebarTrigger({
  className,
  onClick,
  "aria-expanded": ariaExpanded,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { open, toggleSidebar } = useSidebar();

  return (
    <Button
      data-sidebar="trigger"
      variant="ghost"
      size="icon"
      className={cn(
        "h-[28px] w-[28px] rounded-md p-0 [&_[data-icon-root]]:size-[16px]",
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
}

function part<Tag extends "div" | "main" | "ul" | "li">(
  tag: Tag,
  slot: string,
  baseClassName: string,
) {
  return function SidebarPart({
    className,
    ...props
  }: React.ComponentProps<Tag>) {
    return React.createElement(tag, {
      "data-sidebar": slot,
      className: cn(baseClassName, className),
      ...props,
    });
  };
}

const SidebarInset = part(
  "main",
  "inset",
  "relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background motion-reduce:transition-none!",
);
const SidebarFooter = part("div", "footer", "flex flex-col gap-2 p-2");
const SidebarContent = part(
  "div",
  "content",
  "flex min-h-0 flex-1 flex-col gap-2 overflow-auto bg-sidebar",
);
const SidebarMenu = part("ul", "menu", "flex w-full min-w-0 flex-col gap-1");
const SidebarMenuItem = part("li", "menu-item", "group/menu-item relative");

function SidebarMenuButton({
  asChild = false,
  tooltip,
  className,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean;
  tooltip?: React.ComponentProps<typeof TooltipContent>;
}) {
  const Comp = asChild ? Slot : "button";
  const { open } = useSidebar();

  const button = (
    <Comp
      data-sidebar="menu-button"
      className={cn(
        "flex h-8 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-none ring-sidebar-ring transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>[data-icon-root]]:size-4 [&>[data-icon-root]]:shrink-0",
        className,
      )}
      {...props}
    />
  );

  if (!tooltip) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" align="center" hidden={open} {...tooltip} />
    </Tooltip>
  );
}

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
};
