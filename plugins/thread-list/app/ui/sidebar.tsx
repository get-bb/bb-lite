import * as React from "react";
import { cn } from "@bb/shared-ui/lib/utils";

export const SIDEBAR_CONTENT_SELECTOR = '[data-sidebar="content"]';

const SIDEBAR_GROUP_LABEL_BASE_CLASS =
  "duration-200 flex shrink-0 items-center rounded-md px-1 text-xs font-medium text-sidebar-foreground/75 outline-none ring-sidebar-ring transition-[margin,opa] ease-linear focus-visible:ring-2 [&>[data-icon-root]]:size-4 [&>[data-icon-root]]:shrink-0";

const SidebarContentElementContext =
  React.createContext<React.RefObject<HTMLElement | null> | null>(null);

export function useSidebarContentElementRef(): React.RefObject<HTMLElement | null> | null {
  return React.useContext(SidebarContentElementContext);
}

export function SidebarContentElementProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const [element, setElement] = React.useState<HTMLElement | null>(null);
  React.useLayoutEffect(() => {
    const next =
      anchorRef.current?.closest<HTMLElement>(SIDEBAR_CONTENT_SELECTOR) ?? null;
    setElement((current) => (current === next ? current : next));
  }, [anchorRef]);
  const contentRef = React.useMemo(() => ({ current: element }), [element]);
  return (
    <SidebarContentElementContext.Provider value={contentRef}>
      <div ref={anchorRef} className="contents">
        {children}
      </div>
    </SidebarContentElementContext.Provider>
  );
}

interface SidebarStickyTierProps extends React.ComponentProps<"div"> {
  tier: "label" | "parent";
  level?: number;
}

type SidebarStickyParentLevelStyle = React.CSSProperties & {
  "--bb-sidebar-sticky-parent-level": number;
};

export const SidebarStickyStack = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      data-sidebar="group"
      data-sidebar-sticky-stack=""
      className={cn("relative flex w-full min-w-0 flex-col", className)}
      {...props}
    />
  );
});
SidebarStickyStack.displayName = "SidebarStickyStack";

export const SidebarStickyTier = React.forwardRef<
  HTMLDivElement,
  SidebarStickyTierProps
>(({ children, className, tier, level, style, ...props }, ref) => {
  const tierStyle =
    tier === "parent" && level !== undefined
      ? ({
          ...style,
          "--bb-sidebar-sticky-parent-level": level,
        } satisfies SidebarStickyParentLevelStyle)
      : style;
  return (
    <div
      ref={ref}
      {...props}
      style={tierStyle}
      data-sidebar={tier === "label" ? "group-label" : undefined}
      data-sidebar-sticky-tier={tier}
      className={cn(
        tier === "label" && SIDEBAR_GROUP_LABEL_BASE_CLASS,
        "bg-sidebar",
        className,
      )}
    >
      {children}
    </div>
  );
});
SidebarStickyTier.displayName = "SidebarStickyTier";

export const SidebarStickyGroup = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      data-sidebar-sticky-group=""
      className={cn(className)}
      {...props}
    />
  );
});
SidebarStickyGroup.displayName = "SidebarStickyGroup";

export const SidebarGroupContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-sidebar="group-content"
    className={cn("w-full text-sm", className)}
    {...props}
  />
));
SidebarGroupContent.displayName = "SidebarGroupContent";
