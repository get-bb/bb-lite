import { useEffect, useRef, useState } from "react";

export function useScrollOverflowState<TElement extends HTMLElement>() {
  const scrollRef = useRef<TElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const [aboveOverflow, setAboveOverflow] = useState(false);
  const [belowOverflow, setBelowOverflow] = useState(false);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) {
      return;
    }
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      setAboveOverflow(scroll.scrollTop > 1);
      setBelowOverflow(
        scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 1,
      );
    };
    const scheduleMeasure = () => {
      frame ??= window.requestAnimationFrame(measure);
    };
    scheduleMeasure();
    scroll.addEventListener("scroll", scheduleMeasure, { passive: true });
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(scroll);
    const mutationObserver = new MutationObserver(scheduleMeasure);
    mutationObserver.observe(scroll, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      scroll.removeEventListener("scroll", scheduleMeasure);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  return {
    scrollRef,
    topSentinelRef,
    bottomSentinelRef,
    aboveOverflow,
    belowOverflow,
  };
}
