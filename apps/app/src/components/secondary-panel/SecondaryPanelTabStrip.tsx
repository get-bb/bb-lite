import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@bb/shared-ui/context-menu";
import { OverflowFade } from "@/components/ui/overflow-fade";
import { TabPill } from "@/components/ui/tab-pill";
import { cn } from "@bb/shared-ui/lib/utils";

const CHEVRON_SCROLL_STEP_PX = 140;
const EDGE_EPSILON_PX = 1;

export interface SecondaryPanelRenderableTab {
  contentFillsRegion?: boolean;
  label: string;
  leadingVisual: ReactNode;
  onClose: () => void;
  onSelect: () => void;
  renderContent: () => ReactNode;
  statusLabel: string | null;
  tab: { id: string; kind: string };
}

interface SecondaryPanelTabStripProps {
  activeTabId: string | null;
  tabs: readonly SecondaryPanelRenderableTab[];
}

export function SecondaryPanelTabStrip({
  activeTabId,
  tabs,
}: SecondaryPanelTabStripProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const hasOverflow = edges.left || edges.right;

  useEffect(() => {
    const strip = stripRef.current;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (strip === null || viewport === null || content === null) return;
    const measure = () => {
      const overflows =
        content.scrollWidth > strip.clientWidth + EDGE_EPSILON_PX;
      const max = overflows ? viewport.scrollWidth - viewport.clientWidth : 0;
      const left =
        max > EDGE_EPSILON_PX && viewport.scrollLeft > EDGE_EPSILON_PX;
      const right =
        max > EDGE_EPSILON_PX && viewport.scrollLeft < max - EDGE_EPSILON_PX;
      setEdges((current) =>
        current.left === left && current.right === right
          ? current
          : { left, right },
      );
    };
    const handleWheel = (event: WheelEvent) => {
      const max = viewport.scrollWidth - viewport.clientWidth;
      if (
        event.deltaY === 0 ||
        Math.abs(event.deltaX) >= Math.abs(event.deltaY) ||
        max <= EDGE_EPSILON_PX ||
        (event.deltaY > 0
          ? viewport.scrollLeft >= max - EDGE_EPSILON_PX
          : viewport.scrollLeft <= EDGE_EPSILON_PX)
      ) {
        return;
      }
      viewport.scrollLeft = Math.min(
        max,
        Math.max(0, viewport.scrollLeft + event.deltaY),
      );
      event.preventDefault();
    };
    measure();
    viewport.addEventListener("scroll", measure, { passive: true });
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    const resizeObserver = new ResizeObserver(measure);
    for (const element of [strip, viewport, content]) {
      resizeObserver.observe(element);
    }
    return () => {
      viewport.removeEventListener("scroll", measure);
      viewport.removeEventListener("wheel", handleWheel);
      resizeObserver.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    activeTabRef.current?.scrollIntoView({
      inline: "nearest",
      block: "nearest",
    });
  }, [activeTabId, hasOverflow]);

  const closeTabs = (index: number, scope: "self" | "others" | "right") => {
    const closing =
      scope === "self"
        ? tabs.slice(index, index + 1)
        : scope === "right"
          ? tabs.slice(index + 1)
          : tabs.filter((_, tabIndex) => tabIndex !== index);
    if (scope !== "self" && closing.some((tab) => tab.tab.id === activeTabId)) {
      tabs[index]?.onSelect();
    }
    for (const tab of closing) tab.onClose();
  };
  const scrollButton = (direction: "left" | "right") => {
    const canScroll = edges[direction];
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        tabIndex={canScroll ? 0 : -1}
        aria-hidden={!canScroll}
        aria-label={
          direction === "left" ? "Scroll tabs left" : "Scroll tabs right"
        }
        onClick={() =>
          viewportRef.current?.scrollBy({
            left:
              direction === "left"
                ? -CHEVRON_SCROLL_STEP_PX
                : CHEVRON_SCROLL_STEP_PX,
            behavior: "smooth",
          })
        }
        className={cn(
          "z-20 shrink-0 bg-sidebar text-muted-foreground/70 shadow-none hover:bg-surface-raised-solid hover:text-foreground focus-visible:bg-sidebar",
          canScroll
            ? "h-7 w-5 rounded-md p-0 [&_[data-icon-root]]:size-3.5"
            : "h-7 w-0 overflow-hidden p-0",
          "transition-opacity",
          canScroll
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        )}
      >
        <Icon name={direction === "left" ? "ChevronLeft" : "ChevronRight"} />
      </Button>
    );
  };

  return (
    <div
      ref={stripRef}
      data-testid="secondary-panel-tab-strip"
      className="group relative flex min-w-0 items-center [&_[data-tab-pill-close]]:text-muted-foreground/70 [&_[data-tab-pill-close]:hover]:text-foreground [&_[data-tab-pill-close]_[data-icon-root]]:size-3"
    >
      {scrollButton("left")}
      <div data-secondary-panel-tab-scroll-region className="relative min-w-0">
        <OverflowFade
          placement="left"
          tone="sidebar"
          className={cn("z-10", edges.left ? "opacity-100" : "opacity-0")}
        />
        <OverflowFade
          placement="right"
          tone="sidebar"
          className={cn("z-10", edges.right ? "opacity-100" : "opacity-0")}
        />
        <div
          ref={viewportRef}
          className="no-scrollbar min-w-0 overflow-x-auto overflow-y-hidden"
        >
          <div
            ref={contentRef}
            data-secondary-panel-tab-content
            className="flex w-max items-center gap-1"
          >
            {tabs.map((tab, index) => {
              const isActive = tab.tab.id === activeTabId;
              return (
                <ContextMenu key={tab.tab.id} modal={false}>
                  <ContextMenuTrigger asChild>
                    <div
                      ref={isActive ? activeTabRef : undefined}
                      className="shrink-0"
                    >
                      <TabPill
                        label={tab.label}
                        leadingVisual={tab.leadingVisual}
                        secondaryLabel={
                          tab.statusLabel === null
                            ? null
                            : `(${tab.statusLabel})`
                        }
                        title={
                          tab.statusLabel === null
                            ? tab.label
                            : `${tab.label} (${tab.statusLabel})`
                        }
                        isActive={isActive}
                        onSelect={tab.onSelect}
                        labelMaxWidthClass="max-w-[160px]"
                        closeAction={{
                          onClose: tab.onClose,
                          closeLabel: `Close ${tab.label}`,
                        }}
                      />
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent aria-label={`${tab.label} tab actions`}>
                    <ContextMenuItem onSelect={() => closeTabs(index, "self")}>
                      Close tab
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      disabled={tabs.length < 2}
                      onSelect={() => closeTabs(index, "others")}
                    >
                      Close other tabs
                    </ContextMenuItem>
                    <ContextMenuItem
                      disabled={index === tabs.length - 1}
                      onSelect={() => closeTabs(index, "right")}
                    >
                      Close tabs to the right
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
        </div>
      </div>
      {scrollButton("right")}
    </div>
  );
}
