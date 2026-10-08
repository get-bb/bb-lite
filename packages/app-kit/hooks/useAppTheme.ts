import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { useSystemConfig } from "./queries/system-queries";
import {
  applyAppTheme,
  getAppThemeEpoch,
  previewAppTheme,
  setPluginThemes,
  subscribeAppThemeChange,
} from "../lib/themes";

export function useAppTheme(): void {
  const config = useSystemConfig().data;
  const themeId = config?.appearance.themeId;
  const themes = config?.themes;
  useLayoutEffect(() => {
    if (themes !== undefined) setPluginThemes(themes);
    if (themeId !== undefined) applyAppTheme(themeId);
  }, [themeId, themes]);
}

export function useAppThemeEpoch(): number {
  return useSyncExternalStore(subscribeAppThemeChange, getAppThemeEpoch);
}

export function useAppThemePreview(): typeof previewAppTheme {
  useEffect(() => () => previewAppTheme(null), []);
  return previewAppTheme;
}
