import { useEffect, useState } from "react";
import {
  areLanguagesAttached,
  areThemesAttached,
  getFiletypeFromFileName,
  getHighlighterIfLoaded,
  preloadHighlighter,
  registerCustomTheme,
} from "@pierre/diffs";
import { stampRegisteredThemeName } from "@bb/domain";
import {
  getResolvedCodeTheme,
  useResolvedCodeThemePair,
} from "@/lib/code-theme";

const registeredFileNames = new Set<string>();

export function useCodeHighlighter(path: string) {
  const theme = useResolvedCodeThemePair();
  for (const [name, file] of Object.entries(getResolvedCodeTheme().files)) {
    if (registeredFileNames.has(name)) continue;
    registeredFileNames.add(name);
    const stamped = stampRegisteredThemeName(name, file);
    registerCustomTheme(name, () => Promise.resolve(stamped));
  }
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
