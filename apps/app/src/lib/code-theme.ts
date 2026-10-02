import { useSyncExternalStore } from "react";
import { defaultResolvedCodeTheme, type ResolvedCodeTheme } from "@bb/domain";

let committed: ResolvedCodeTheme = defaultResolvedCodeTheme;
let previewed: ResolvedCodeTheme | null = null;
let current: ResolvedCodeTheme = defaultResolvedCodeTheme;
let pair = { dark: current.dark, light: current.light };
const subscribers = new Set<() => void>();

function publish(): void {
  const next = previewed ?? committed;
  if (next.dark === current.dark && next.light === current.light) return;
  current = next;
  pair = { dark: next.dark, light: next.light };
  for (const subscriber of subscribers) subscriber();
}

function subscribe(callback: () => void): () => void {
  subscribers.add(callback);
  return () => void subscribers.delete(callback);
}

export function getResolvedCodeTheme(): ResolvedCodeTheme {
  return current;
}

export function applyResolvedCodeTheme(resolved: ResolvedCodeTheme): void {
  committed = resolved;
  previewed = null;
  publish();
}

export function previewResolvedCodeTheme(
  resolved: ResolvedCodeTheme | null,
): void {
  previewed = resolved;
  publish();
}

export function useResolvedCodeThemePair(): { dark: string; light: string } {
  return useSyncExternalStore(subscribe, () => pair);
}
