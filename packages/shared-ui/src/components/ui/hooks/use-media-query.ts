import { useSyncExternalStore } from "react";

export const DARK_COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const hasMatchMedia = () =>
  typeof window !== "undefined" && !!window.matchMedia;

export function subscribeMediaQuery(
  query: string,
  notify: () => void,
): () => void {
  if (!hasMatchMedia()) return () => {};
  const mql = window.matchMedia(query);
  mql.addEventListener("change", notify);
  return () => mql.removeEventListener("change", notify);
}

export function getMediaQuerySnapshot(query: string): boolean {
  return hasMatchMedia() && window.matchMedia(query).matches;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => subscribeMediaQuery(query, notify),
    () => getMediaQuerySnapshot(query),
    () => false,
  );
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery(REDUCED_MOTION_QUERY);
}
