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
import { deriveLightCodeTheme, lightCodeThemes } from "@bb/domain";
import { useResolvedCodeThemePair } from "@/lib/code-theme";

for (const light of lightCodeThemes) {
  registerCustomTheme(light.name, async () =>
    deriveLightCodeTheme(await resolveTheme(light.dark), light),
  );
}

export function useCodeHighlighter(path: string) {
  const theme = useResolvedCodeThemePair();
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
