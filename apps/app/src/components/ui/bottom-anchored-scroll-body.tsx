import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { cn } from "@bb/shared-ui/lib/utils";
import { PAGE_SHELL_CONTENT_STYLE } from "./page-shell-content-style.js";
import { supportsScrollAnchoring } from "@/lib/scroll-anchoring-support";

export interface BottomAnchorContextValue {
  getScrollElement: () => HTMLElement | null;
  isAtBottom: boolean;
  scrollToBottom: () => void;
  scrollElementIntoView: (args: {
    element: HTMLElement;
    options?: ScrollIntoViewOptions;
  }) => void;
  scrollElementIntoViewClampedToMaxScroll: (args: {
    element: HTMLElement;
  }) => void;
  captureScrollAnchor: () => void;
}

interface BottomAnchoredScrollBodyProps {
  children: ReactNode;
  footer: ReactNode;
  scrollAreaClassName?: string;
  contentClassName?: string;
  maxWidthClassName: string;
}

const BOTTOM_ANCHOR_THRESHOLD_PX = 4;
const USER_SCROLL_INTENT_MS = 1_000;
const SCROLLBAR_IDLE_DELAY_MS = 600;
const SCROLL_INTENT_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);

const BottomAnchorContext = createContext<BottomAnchorContextValue | null>(
  null,
);

export function useBottomAnchoredScroll(): BottomAnchorContextValue | null {
  return useContext(BottomAnchorContext);
}

function maxScrollOffset(element: HTMLElement) {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function isNearBottom(element: HTMLElement) {
  return (
    maxScrollOffset(element) - element.scrollTop <= BOTTOM_ANCHOR_THRESHOLD_PX
  );
}

export function BottomAnchoredScrollBody({
  scrollAreaClassName,
  contentClassName,
  maxWidthClassName,
  footer,
  children,
}: BottomAnchoredScrollBodyProps) {
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const userScrollIntentUntilRef = useRef(0);
  const pointerScrollIntentRef = useRef(false);
  const settleFrameRef = useRef<number | null>(null);
  const pendingPrependAnchorRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const setStuck = (stuck: boolean) => {
    stickToBottomRef.current = stuck;
    setIsAtBottom(stuck);
  };

  const pinToBottom = () => {
    const scrollArea = scrollAreaRef.current;
    if (scrollArea && stickToBottomRef.current && !isNearBottom(scrollArea)) {
      scrollArea.scrollTop = maxScrollOffset(scrollArea);
    }
  };

  const pinToBottomAndSettle = () => {
    pinToBottom();
    if (settleFrameRef.current !== null) return;
    settleFrameRef.current = window.requestAnimationFrame(() => {
      settleFrameRef.current = null;
      pinToBottom();
    });
  };

  const restorePrependAnchor = () => {
    const scrollArea = scrollAreaRef.current;
    const anchor = pendingPrependAnchorRef.current;
    if (!scrollArea || !anchor) return;
    const delta = scrollArea.scrollHeight - anchor.scrollHeight;
    if (delta <= 0) return;
    scrollArea.scrollTop = anchor.scrollTop + delta;
    pendingPrependAnchorRef.current = null;
  };

  useLayoutEffect(restorePrependAnchor);

  const [controls] = useState(() => ({
    getScrollElement: () => scrollAreaRef.current,
    scrollToBottom: () => {
      userScrollIntentUntilRef.current = 0;
      pointerScrollIntentRef.current = false;
      setStuck(true);
      pinToBottomAndSettle();
    },
    scrollElementIntoView: ({
      element,
      options,
    }: {
      element: HTMLElement;
      options?: ScrollIntoViewOptions;
    }) => {
      const scrollArea = scrollAreaRef.current;
      if (scrollArea) {
        const elementRect = element.getBoundingClientRect();
        const areaRect = scrollArea.getBoundingClientRect();
        if (
          elementRect.top >= areaRect.top &&
          elementRect.bottom <= areaRect.bottom
        ) {
          return;
        }
      }
      setStuck(false);
      element.scrollIntoView(options);
    },
    scrollElementIntoViewClampedToMaxScroll: ({
      element,
    }: {
      element: HTMLElement;
    }) => {
      const scrollArea = scrollAreaRef.current;
      if (!scrollArea) {
        element.scrollIntoView({ block: "start", inline: "nearest" });
        return;
      }
      scrollArea.scrollTop = Math.min(
        maxScrollOffset(scrollArea),
        Math.max(
          0,
          element.getBoundingClientRect().top -
            scrollArea.getBoundingClientRect().top +
            scrollArea.scrollTop,
        ),
      );
      setStuck(isNearBottom(scrollArea));
    },
    captureScrollAnchor: () => {
      const scrollArea = scrollAreaRef.current;
      if (!scrollArea) return;
      pendingPrependAnchorRef.current = {
        scrollHeight: scrollArea.scrollHeight,
        scrollTop: scrollArea.scrollTop,
      };
    },
  }));

  useEffect(() => {
    const scrollArea = scrollAreaRef.current;
    const scrollContent = scrollContentRef.current;
    if (!scrollArea || !scrollContent) return;

    const hasUserScrollIntent = () =>
      pointerScrollIntentRef.current ||
      window.performance.now() <= userScrollIntentUntilRef.current;
    const markUserScrollIntent = () => {
      userScrollIntentUntilRef.current =
        window.performance.now() + USER_SCROLL_INTENT_MS;
    };

    let scrollbarIdleTimeout: number | null = null;
    const handleScroll = () => {
      scrollArea.dataset.scrollbarScrolling = "true";
      if (scrollbarIdleTimeout !== null) {
        window.clearTimeout(scrollbarIdleTimeout);
      }
      scrollbarIdleTimeout = window.setTimeout(() => {
        scrollbarIdleTimeout = null;
        scrollArea.removeAttribute("data-scrollbar-scrolling");
      }, SCROLLBAR_IDLE_DELAY_MS);

      const userScrolled = hasUserScrollIntent();
      if (pendingPrependAnchorRef.current !== null && userScrolled) {
        pendingPrependAnchorRef.current.scrollTop = scrollArea.scrollTop;
        setStuck(false);
      } else if (isNearBottom(scrollArea)) {
        userScrollIntentUntilRef.current = 0;
        setStuck(true);
      } else if (userScrolled) {
        setStuck(false);
      }
    };
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY > 0 && isNearBottom(scrollArea)) {
        userScrollIntentUntilRef.current = 0;
        return;
      }
      markUserScrollIntent();
    };
    const startPointerScrollIntent = () => {
      pointerScrollIntentRef.current = true;
    };
    const endPointerScrollIntent = () => {
      pointerScrollIntentRef.current = false;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (!SCROLL_INTENT_KEYS.has(event.key)) return;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (
        target instanceof Node &&
        target !== document.body &&
        target !== document.documentElement &&
        !scrollArea.contains(target)
      ) {
        return;
      }
      markUserScrollIntent();
    };

    const resizeObserver = new ResizeObserver(() => {
      restorePrependAnchor();
      if (!stickToBottomRef.current && isNearBottom(scrollArea)) {
        setStuck(true);
      }
      pinToBottomAndSettle();
    });
    resizeObserver.observe(scrollArea);
    resizeObserver.observe(scrollContent);

    scrollArea.addEventListener("scroll", handleScroll, { passive: true });
    scrollArea.addEventListener("wheel", handleWheel, { passive: true });
    scrollArea.addEventListener("pointerdown", startPointerScrollIntent, {
      passive: true,
    });
    window.addEventListener("pointerup", endPointerScrollIntent);
    window.addEventListener("pointercancel", endPointerScrollIntent);
    window.addEventListener("keydown", handleKeyDown);
    pinToBottomAndSettle();

    return () => {
      resizeObserver.disconnect();
      scrollArea.removeEventListener("scroll", handleScroll);
      scrollArea.removeEventListener("wheel", handleWheel);
      scrollArea.removeEventListener("pointerdown", startPointerScrollIntent);
      window.removeEventListener("pointerup", endPointerScrollIntent);
      window.removeEventListener("pointercancel", endPointerScrollIntent);
      window.removeEventListener("keydown", handleKeyDown);
      if (scrollbarIdleTimeout !== null) {
        window.clearTimeout(scrollbarIdleTimeout);
      }
      if (settleFrameRef.current !== null) {
        window.cancelAnimationFrame(settleFrameRef.current);
        settleFrameRef.current = null;
      }
      scrollArea.removeAttribute("data-scrollbar-scrolling");
    };
  }, []);

  const contextValue = useMemo(
    () => ({ ...controls, isAtBottom }),
    [controls, isAtBottom],
  );

  return (
    <BottomAnchorContext.Provider value={contextValue}>
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(auto,1fr)] overflow-hidden">
        <div
          ref={scrollAreaRef}
          className={cn(
            "thread-scrollbar @container/page col-start-1 row-start-1 min-h-0 overflow-x-hidden overflow-y-auto",
            scrollAreaClassName,
          )}
        >
          <div
            ref={scrollContentRef}
            className="flex min-h-full min-w-0 flex-col"
          >
            <div
              className={cn(
                "mx-auto flex w-full min-w-0 flex-1 flex-col px-4 pb-4 pt-2",
                maxWidthClassName,
                contentClassName,
                isAtBottom &&
                  supportsScrollAnchoring() &&
                  "scroll-bottom-anchor-content",
              )}
              style={PAGE_SHELL_CONTENT_STYLE}
            >
              {children}
            </div>
            <div className="scroll-bottom-anchor" aria-hidden />
            {footer ? (
              <div
                data-scroll-footer=""
                className="sticky bottom-0 z-20 shrink-0 [overflow-anchor:none]"
              >
                {footer}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </BottomAnchorContext.Provider>
  );
}
