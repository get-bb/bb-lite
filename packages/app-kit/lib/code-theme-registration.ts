import { useEffect, useState } from "react";
import {
  areLanguagesAttached,
  areThemesAttached,
  getFiletypeFromFileName,
  getHighlighterIfLoaded,
  preloadHighlighter,
  registerCustomTheme,
  resolveTheme,
} from "@pierre/diffs";
import {
  deriveLightCodeTheme,
  lightCodeThemes,
  type JsonObject,
} from "@bb/domain";
import type { CodeTheme } from "@bb/plugin/app";
import { codeThemeData } from "./code-theme-data";
import { useResolvedCodeThemePair } from "./code-theme";
import { usePreferredTheme } from "../hooks/useTheme";

for (const light of lightCodeThemes) {
  registerCustomTheme(light.name, async () =>
    deriveLightCodeTheme(await resolveTheme(light.dark), light),
  );
}

const servedThemes = new Set<string>();

function registerServedTheme(name: string): void {
  if (!name.startsWith("/api/") || servedThemes.has(name)) return;
  servedThemes.add(name);
  registerCustomTheme(name, async () => {
    const response = await fetch(name);
    if (!response.ok) throw new Error(`Code theme ${name} did not load`);
    const theme = (await response.json()) as JsonObject;
    return { ...theme, name };
  });
}

export function useCodeHighlighter(path: string) {
  const theme = useResolvedCodeThemePair();
  registerServedTheme(theme.dark);
  registerServedTheme(theme.light);
  const language = getFiletypeFromFileName(path);
  const key = `${language}:${theme.dark}:${theme.light}`;
  const [settledKey, setSettledKey] = useState("");
  const isReady =
    settledKey === key ||
    (getHighlighterIfLoaded() !== undefined &&
      areThemesAttached(theme) &&
      areLanguagesAttached(language));
  useEffect(() => {
    if (isReady) return;
    let cancelled = false;
    const settle = () => {
      if (!cancelled) setSettledKey(key);
    };
    preloadHighlighter({
      themes: [theme.dark, theme.light],
      langs: [language],
    }).then(settle, settle);
    return () => {
      cancelled = true;
    };
  }, [isReady, key, language, theme.dark, theme.light]);
  return { theme, isReady };
}

export function useCodeTheme(): CodeTheme | null {
  const pair = useResolvedCodeThemePair();
  const dark = usePreferredTheme() === "dark";
  const name = dark ? pair.dark : pair.light;
  registerServedTheme(name);
  const [resolved, setResolved] = useState<CodeTheme | null>(null);
  useEffect(() => {
    let current = true;
    resolveTheme(name).then(
      (raw) => {
        if (current) setResolved(codeThemeData(name, dark, raw));
      },
      () => {
        if (current) setResolved(null);
      },
    );
    return () => {
      current = false;
    };
  }, [name, dark]);
  return resolved?.name === name ? resolved : null;
}
