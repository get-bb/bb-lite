import { useEffect, useRef } from "react";

const STICKY_BOTTOM_THRESHOLD_PX = 4;
const USER_SCROLL_INTENT_MS = 350;
const SMOOTH_SCROLL_MIN_GAP_MS = 250;

export function useStickyBottomScroll<TElement extends HTMLElement>({
  contentKey,
  streaming,
}: {
  contentKey: string;
  streaming: boolean;
}) {
  const scrollRef = useRef<TElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const pointerScrollIntentRef = useRef(false);
  const userScrollIntentUntilRef = useRef(0);
  const lastScrollAtRef = useRef<number | null>(null);
  const wasStreamingRef = useRef(streaming);

  useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = streaming;
    const element = scrollRef.current;
    if (
      (!streaming && !wasStreaming) ||
      !element ||
      !shouldStickToBottomRef.current
    ) {
      return;
    }
    const now = window.performance.now();
    const top = Math.max(0, element.scrollHeight - element.clientHeight);
    if (
      lastScrollAtRef.current !== null &&
      now - lastScrollAtRef.current >= SMOOTH_SCROLL_MIN_GAP_MS
    ) {
      element.scrollTo({ top, behavior: "smooth" });
    } else {
      element.scrollTop = top;
    }
    lastScrollAtRef.current = now;
  }, [contentKey, streaming]);

  useEffect(() => {
    if (!streaming) {
      return;
    }
    const onPointerEnd = () => {
      pointerScrollIntentRef.current = false;
    };
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    return () => {
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
    };
  }, [streaming]);

  const markUserScrollIntent = () => {
    userScrollIntentUntilRef.current =
      window.performance.now() + USER_SCROLL_INTENT_MS;
  };

  return {
    ref: scrollRef,
    onPointerDown: () => {
      pointerScrollIntentRef.current = true;
    },
    onScroll: () => {
      const element = scrollRef.current;
      if (!element) {
        return;
      }
      if (
        element.scrollHeight - element.clientHeight - element.scrollTop <=
        STICKY_BOTTOM_THRESHOLD_PX
      ) {
        shouldStickToBottomRef.current = true;
      } else if (
        pointerScrollIntentRef.current ||
        window.performance.now() <= userScrollIntentUntilRef.current
      ) {
        shouldStickToBottomRef.current = false;
      }
    },
    onTouchMove: markUserScrollIntent,
    onTouchStart: markUserScrollIntent,
    onWheel: markUserScrollIntent,
  };
}
