import { useSyncExternalStore } from "react";
import {
  DARK_COLOR_SCHEME_QUERY,
  getMediaQuerySnapshot,
  subscribeMediaQuery,
} from "@bb/shared-ui/hooks/use-media-query";
import { refreshThemeColorMeta } from "@/lib/themes";

const THEME_STORAGE_KEY = "bb.theme";

type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

function readPreference(): ThemePreference {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {}
  return stored === "light" || stored === "dark" ? stored : "system";
}

let preference = readPreference();
const subscribers = new Set<() => void>();

function subscribe(callback: () => void): () => void {
  subscribers.add(callback);
  return () => void subscribers.delete(callback);
}

function getTheme(): Theme {
  if (preference !== "system") return preference;
  return getMediaQuerySnapshot(DARK_COLOR_SCHEME_QUERY) ? "dark" : "light";
}

function getPreference(): ThemePreference {
  return preference;
}

function applyTheme(): void {
  document.documentElement.classList.toggle("dark", getTheme() === "dark");
  refreshThemeColorMeta();
  for (const callback of subscribers) callback();
}

export function setPreferredTheme(next: ThemePreference): void {
  preference = next;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {}
  applyTheme();
}

export function initializePreferredTheme(): void {
  subscribeMediaQuery(DARK_COLOR_SCHEME_QUERY, applyTheme);
  applyTheme();
}

export function usePreferredTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme);
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, getPreference);
}
