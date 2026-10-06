import { useEffect, useRef, useState } from "react";
import { useIsRouteNavigationPending } from "./app-route-anchor";

function useDelayedBusyIndicator(busy: boolean): boolean {
  const [visible, setVisible] = useState(false);
  const shownAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (busy) {
      if (shownAtRef.current !== null) return;
      const revealTimeout = window.setTimeout(() => {
        shownAtRef.current = Date.now();
        setVisible(true);
      }, 120);
      return () => window.clearTimeout(revealTimeout);
    }

    const shownAt = shownAtRef.current;
    if (shownAt === null) {
      setVisible(false);
      return;
    }

    const remainingMs = 320 - (Date.now() - shownAt);
    if (remainingMs <= 0) {
      shownAtRef.current = null;
      setVisible(false);
      return;
    }

    const hideTimeout = window.setTimeout(() => {
      shownAtRef.current = null;
      setVisible(false);
    }, remainingMs);
    return () => window.clearTimeout(hideTimeout);
  }, [busy]);

  return visible;
}

export function RouteNavigationIndicator() {
  if (!useDelayedBusyIndicator(useIsRouteNavigationPending())) return null;

  return (
    <div
      data-testid="route-navigation-indicator"
      role="progressbar"
      aria-label="Loading page"
      className="pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top)] z-100 h-0.5 overflow-hidden bg-transparent"
    >
      <div className="h-full w-1/3 animate-indeterminate-progress rounded-full bg-muted-foreground" />
    </div>
  );
}
