import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const RESOURCE_LIST_PAGE_SIZE = 10;
export const RESOURCE_GRID_PAGE_SIZE = 12;

interface ResourcePaginationOptions {
  pageSize?: number;
  resetKey?: string;
}

interface ResourceViewportPageSizeOptions {
  fallbackPageSize?: number;
  resetKey?: string;
}

function cssPixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface ResourceViewportMeasurement {
  pageSize: number;
  rowHeight: number;
}

function measureResourceViewportPageSize(
  viewport: HTMLElement,
  fallbackPageSize: number,
  tallestRowHeight: number,
): ResourceViewportMeasurement {
  const availableHeight = viewport.clientHeight;
  const panel = viewport.querySelector<HTMLElement>(
    "[data-resource-list-panel]",
  );
  if (availableHeight <= 0 || panel === null) {
    return { pageSize: fallbackPageSize, rowHeight: tallestRowHeight };
  }

  const rowHeights = Array.from(
    panel.querySelectorAll<HTMLElement>("[data-resource-row]"),
    (row) => row.getBoundingClientRect().height,
  ).filter((height) => Number.isFinite(height) && height > 0);
  if (rowHeights.length === 0) {
    return { pageSize: fallbackPageSize, rowHeight: tallestRowHeight };
  }

  const panelStyle = panel.ownerDocument.defaultView?.getComputedStyle(panel);
  const panelChromeHeight = panelStyle
    ? cssPixelValue(panelStyle.paddingTop) +
      cssPixelValue(panelStyle.paddingBottom) +
      cssPixelValue(panelStyle.borderTopWidth) +
      cssPixelValue(panelStyle.borderBottomWidth)
    : 0;
  const rowHeight = Math.max(tallestRowHeight, ...rowHeights);
  return {
    pageSize: Math.max(
      1,
      Math.floor((availableHeight - panelChromeHeight) / rowHeight),
    ),
    rowHeight,
  };
}

export function useResourceViewportPageSize(
  viewport: HTMLElement | null,
  options: ResourceViewportPageSizeOptions = {},
): number {
  const fallbackPageSize = Math.max(
    1,
    Math.floor(options.fallbackPageSize ?? RESOURCE_LIST_PAGE_SIZE),
  );
  const resetKey = options.resetKey ?? "";
  const [pageSize, setPageSize] = useState(fallbackPageSize);

  useEffect(() => {
    if (viewport === null) return;
    const viewportElement = viewport;

    let observedPanel: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let tallestRowHeight = 0;
    let measuredWidth = viewportElement.clientWidth;
    let scheduledFrame: number | null = null;

    function observeCurrentPanel() {
      const panel = viewportElement.querySelector<HTMLElement>(
        "[data-resource-list-panel]",
      );
      if (panel === observedPanel) return;
      if (observedPanel !== null) resizeObserver?.unobserve(observedPanel);
      observedPanel = panel;
      if (observedPanel !== null) resizeObserver?.observe(observedPanel);
    }

    function measure() {
      observeCurrentPanel();
      const width = viewportElement.clientWidth;
      if (width !== measuredWidth) {
        measuredWidth = width;
        tallestRowHeight = 0;
      }
      const measurement = measureResourceViewportPageSize(
        viewportElement,
        fallbackPageSize,
        tallestRowHeight,
      );
      tallestRowHeight = measurement.rowHeight;
      setPageSize((current) =>
        current === measurement.pageSize ? current : measurement.pageSize,
      );
    }

    function scheduleMeasure() {
      if (typeof requestAnimationFrame !== "function") {
        measure();
        return;
      }
      if (scheduledFrame !== null) return;
      scheduledFrame = requestAnimationFrame(() => {
        scheduledFrame = null;
        measure();
      });
    }

    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(scheduleMeasure);
      resizeObserver.observe(viewportElement);
    }
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(scheduleMeasure);
    mutationObserver?.observe(viewportElement, {
      childList: true,
      subtree: true,
    });
    measure();

    return () => {
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      if (
        scheduledFrame !== null &&
        typeof cancelAnimationFrame === "function"
      ) {
        cancelAnimationFrame(scheduledFrame);
      }
    };
  }, [fallbackPageSize, resetKey, viewport]);

  return viewport === null ? fallbackPageSize : pageSize;
}

interface ResourceInfiniteItemsResult<Item> {
  items: readonly Item[];
  total: number;
  hasMore: boolean;
  loadMore: () => void;
}

export function useResourceInfiniteItems<Item>(
  items: readonly Item[],
  options: ResourcePaginationOptions = {},
): ResourceInfiniteItemsResult<Item> {
  const pageSize = Math.max(
    1,
    Math.floor(options.pageSize ?? RESOURCE_LIST_PAGE_SIZE),
  );
  const resetKey = options.resetKey ?? "";
  const [anchor, setAnchor] = useState({ resetKey, loadedCount: 0 });
  if (anchor.resetKey !== resetKey) {
    setAnchor({ resetKey, loadedCount: 0 });
  }
  const loadedCount = anchor.resetKey === resetKey ? anchor.loadedCount : 0;
  const visibleCount = Math.max(pageSize, loadedCount);
  const visibleItems = useMemo(
    () => items.slice(0, visibleCount),
    [items, visibleCount],
  );
  const hasMore = items.length > visibleItems.length;
  const loadMore = useCallback(() => {
    setAnchor((current) => ({
      resetKey,
      loadedCount:
        (current.resetKey === resetKey
          ? Math.max(pageSize, current.loadedCount)
          : pageSize) + pageSize,
    }));
  }, [pageSize, resetKey]);
  return { items: visibleItems, total: items.length, hasMore, loadMore };
}

export function ResourceInfiniteScrollSentinel({
  hasMore,
  itemCount,
  loading = false,
  onLoadMore,
}: {
  hasMore: boolean;
  itemCount: number;
  loading?: boolean;
  onLoadMore: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  useEffect(() => {
    const element = ref.current;
    if (
      element === null ||
      !hasMore ||
      loading ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const root = element.closest(
      "[data-resource-collection-scroll], [data-infinite-scroll-root]",
    );
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMoreRef.current();
        }
      },
      {
        root: root instanceof HTMLElement ? root : null,
        rootMargin: "240px 0px",
      },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, itemCount, loading]);

  if (!hasMore && !loading) return null;
  return (
    <div
      ref={ref}
      data-resource-infinite-sentinel
      className="flex items-center justify-center py-3"
    >
      {loading ? (
        <span
          className="text-xs text-subtle-foreground"
          role="status"
          aria-live="polite"
        >
          Loading more…
        </span>
      ) : null}
    </div>
  );
}
