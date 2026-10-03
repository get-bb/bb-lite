import type { ReactNode } from "react";
import { cn, useComposedRefs } from "@bb/shared-ui/lib/utils";
import {
  getDetailScrollMaxHeightClass,
  type DetailScrollSize,
} from "../../ui/detail-scroll-size.js";
import { useStickyBottomScroll } from "./useStickyBottomScroll.js";
import { useScrollOverflowState } from "./useScrollOverflowState.js";

export function TimelineDetailScroll({
  size,
  overflowX = "auto",
  streaming = false,
  contentKey,
  className,
  scrollClassName,
  showAboveFade = true,
  children,
}: {
  size: DetailScrollSize;
  overflowX?: "auto" | "hidden";
  streaming?: boolean;
  contentKey: string;
  className?: string;
  scrollClassName?: string;
  showAboveFade?: boolean;
  children: ReactNode;
}) {
  const sticky = useStickyBottomScroll<HTMLDivElement>({
    contentKey,
    streaming,
  });
  const { aboveOverflow, belowOverflow, scrollRef } =
    useScrollOverflowState<HTMLDivElement>();
  const refCallback = useComposedRefs<HTMLDivElement>(sticky.ref, scrollRef);

  return (
    <div
      className={cn("relative isolate min-w-0", className)}
      data-detail-scroll={size}
    >
      <div
        ref={refCallback}
        onScroll={sticky.onScroll}
        onPointerDown={sticky.onPointerDown}
        onWheel={sticky.onWheel}
        data-detail-scroll-area={size}
        className={cn(
          "min-w-0 overflow-y-auto",
          overflowX === "auto" ? "overflow-x-auto" : "overflow-x-hidden",
          getDetailScrollMaxHeightClass(size),
          scrollClassName,
        )}
      >
        <div aria-hidden className="-mb-px h-px w-full" />
        <div>{children}</div>
        <div aria-hidden className="h-px w-full" />
      </div>
      {showAboveFade && aboveOverflow ? (
        <div
          aria-hidden
          data-detail-scroll-fade="above"
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-background to-transparent"
        />
      ) : null}
      {belowOverflow ? (
        <div
          aria-hidden
          data-detail-scroll-fade="below"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-background to-transparent"
        />
      ) : null}
    </div>
  );
}
