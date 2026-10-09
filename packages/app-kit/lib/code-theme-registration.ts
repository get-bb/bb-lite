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
import { useResolvedCodeThemePair } from "./code-theme";

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
