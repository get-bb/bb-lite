import { clampSplitPairFraction } from "@/lib/split-layout";

const SNAP_CAPTURE_PX = 12;
const SNAP_RELEASE_PX = 30;
const PANE_MIN_WIDTH_PX = 240;

export function splitWidthLimits(width: number) {
  const min = PANE_MIN_WIDTH_PX / Math.max(width, 2 * PANE_MIN_WIDTH_PX);
  return { min, max: 1 - min };
}

export function createSplitResizeFlexPair(
  previous: HTMLElement,
  next: HTMLElement,
) {
  const growOf = (element: HTMLElement) =>
    Number.parseFloat(window.getComputedStyle(element).flexGrow);
  const sum = growOf(previous) + growOf(next);
  const total = Number.isFinite(sum) && sum > 0 ? sum : 1;
  const previousFlex = previous.style.flex;
  const nextFlex = next.style.flex;
  return {
    apply: (fraction: number) => {
      previous.style.flex = `${total * fraction} 1 0px`;
      next.style.flex = `${total * (1 - fraction)} 1 0px`;
    },
    restore: () => {
      previous.style.flex = previousFlex;
      next.style.flex = nextFlex;
    },
  };
}

export function createSplitResizeSnapSession(
  divider: HTMLElement,
  axis: "x" | "y",
  { boundaryIndex, childCount }: { boundaryIndex: number; childCount: number },
) {
  const horizontal = axis === "x";
  const sizeOf = (rect: DOMRect) => (horizontal ? rect.width : rect.height);
  const grid =
    divider
      .closest<HTMLElement>("[data-split-resize-grid-root]")
      ?.getBoundingClientRect() ?? null;
  const extent = sizeOf(divider.getBoundingClientRect());
  const usesPanelWidthLimits =
    horizontal && divider.matches("[data-panel-resize-snap-handle]");
  const gridContentSpan =
    grid === null ? 0 : sizeOf(grid) - extent * (childCount - 1);
  const hasGridBoundary =
    Number.isInteger(boundaryIndex) &&
    Number.isInteger(childCount) &&
    boundaryIndex >= 1 &&
    boundaryIndex < childCount &&
    gridContentSpan > 0;
  const gridCoordinate =
    grid === null || !hasGridBoundary
      ? null
      : (horizontal ? grid.left : grid.top) +
        (gridContentSpan * boundaryIndex) / childCount +
        extent * (boundaryIndex - 0.5);
  let guide: HTMLElement | null = null;
  let fastCrossingAnchor: number | null = null;
  let lastPointer: number | null = null;
  let releasePending = false;
  let snapped = false;

  const showGuide = (coordinate: number) => {
    if (grid === null) return;
    if (guide === null) {
      guide = divider.ownerDocument.createElement("div");
      guide.setAttribute("aria-hidden", "true");
      guide.dataset.splitResizeSnapGuide = axis;
      guide.className = horizontal
        ? "pointer-events-none fixed z-[100] w-px -translate-x-1/2 bg-ring/50"
        : "pointer-events-none fixed z-[100] h-px -translate-y-1/2 bg-ring/50";
      guide.style[horizontal ? "height" : "width"] =
        `${horizontal ? grid.height : grid.width}px`;
      guide.style[horizontal ? "top" : "left"] =
        `${horizontal ? grid.top : grid.left}px`;
      divider.ownerDocument.body.appendChild(guide);
    }
    guide.style[horizontal ? "left" : "top"] = `${coordinate}px`;
  };
  const release = () => {
    guide?.remove();
    guide = null;
    fastCrossingAnchor = null;
    releasePending = false;
    snapped = false;
  };
  const shouldSnap = (pointer: number, previousPointer: number | null) => {
    if (gridCoordinate === null) return false;
    const distance = Math.abs(pointer - gridCoordinate);
    const previousDelta =
      previousPointer === null ? 0 : previousPointer - gridCoordinate;
    const delta = pointer - gridCoordinate;
    const crossedGrid =
      (previousDelta < 0 && delta >= 0) || (previousDelta > 0 && delta <= 0);
    if (distance <= SNAP_CAPTURE_PX || crossedGrid) {
      fastCrossingAnchor =
        distance > SNAP_CAPTURE_PX && distance > SNAP_RELEASE_PX
          ? pointer
          : null;
      releasePending = false;
      return true;
    }
    if (!snapped) return false;
    if (distance <= SNAP_RELEASE_PX) {
      fastCrossingAnchor = null;
      releasePending = false;
      return true;
    }
    if (
      fastCrossingAnchor !== null &&
      Math.abs(pointer - fastCrossingAnchor) <= SNAP_RELEASE_PX
    ) {
      releasePending = false;
      return true;
    }
    if (releasePending) return false;
    releasePending = true;
    return true;
  };

  return {
    clear: () => {
      release();
      lastPointer = null;
    },
    resolve: (args: { end: number; pointer: number; start: number }) => {
      const { pointer, start } = args;
      const contentSpan = args.end - start - extent;
      const limits = usesPanelWidthLimits
        ? splitWidthLimits(contentSpan)
        : null;
      const fractionAt = (coordinate: number) => {
        const fraction =
          contentSpan > 0
            ? (coordinate - start - extent / 2) / contentSpan
            : 0.5;
        return limits === null
          ? clampSplitPairFraction(fraction)
          : Math.min(limits.max, Math.max(limits.min, fraction));
      };
      const previousPointer = lastPointer;
      lastPointer = pointer;
      if (gridCoordinate !== null && contentSpan > 0) {
        const fraction = fractionAt(gridCoordinate);
        const coordinate = start + contentSpan * fraction + extent / 2;
        if (
          Math.abs(coordinate - gridCoordinate) <= 0.01 &&
          shouldSnap(pointer, previousPointer)
        ) {
          snapped = true;
          showGuide(coordinate);
          return { fraction };
        }
      }
      release();
      return { fraction: fractionAt(pointer) };
    },
  };
}
