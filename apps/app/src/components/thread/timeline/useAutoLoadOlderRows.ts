import { useEffect, useState } from "react";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body.js";

const AUTO_LOAD_OLDER_ROWS_PREFETCH_MARGIN_PX = 600;

export function useAutoLoadOlderRows({
  hasOlderTimelineRows,
  isLoadingOlderTimelineRows,
  onLoadOlderRows,
}: {
  hasOlderTimelineRows: boolean;
  isLoadingOlderTimelineRows: boolean;
  onLoadOlderRows: (() => Promise<void> | void) | undefined;
}) {
  const bottomAnchor = useBottomAnchoredScroll();
  const captureScrollAnchor = bottomAnchor?.captureScrollAnchor;
  const getScrollElement = bottomAnchor?.getScrollElement;
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null);
  const [autoLoadFailed, setAutoLoadFailed] = useState(false);
  const isAutoLoadEnabled =
    bottomAnchor !== null &&
    hasOlderTimelineRows &&
    onLoadOlderRows !== undefined &&
    !autoLoadFailed;

  const loadOlderRows = () => {
    setAutoLoadFailed(false);
    captureScrollAnchor?.();
    void Promise.resolve(onLoadOlderRows?.()).catch(() => {
      setAutoLoadFailed(true);
    });
  };

  useEffect(() => {
    if (
      !isAutoLoadEnabled ||
      isLoadingOlderTimelineRows ||
      !sentinel ||
      !onLoadOlderRows
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.at(-1)?.isIntersecting) return;
        observer.disconnect();
        captureScrollAnchor?.();
        void Promise.resolve(onLoadOlderRows()).catch(() => {
          setAutoLoadFailed(true);
        });
      },
      {
        root: getScrollElement?.() ?? null,
        rootMargin: `${AUTO_LOAD_OLDER_ROWS_PREFETCH_MARGIN_PX}px 0px 0px 0px`,
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    captureScrollAnchor,
    getScrollElement,
    isAutoLoadEnabled,
    isLoadingOlderTimelineRows,
    onLoadOlderRows,
    sentinel,
  ]);

  return { sentinelRef: setSentinel, isAutoLoadEnabled, loadOlderRows };
}
