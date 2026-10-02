import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import {
  applyAppTheme,
  getAppThemeEpoch,
  previewAppTheme,
  subscribeAppThemeChange,
} from "@/lib/themes";

export function useAppTheme(): void {
  const themeId = useSystemConfig().data?.appearance.themeId;
  useLayoutEffect(() => {
    if (themeId !== undefined) applyAppTheme(themeId);
  }, [themeId]);
}

export function useAppThemeEpoch(): number {
  return useSyncExternalStore(subscribeAppThemeChange, getAppThemeEpoch);
}

export function useAppThemePreview(): typeof previewAppTheme {
  useEffect(() => () => previewAppTheme(null), []);
  return previewAppTheme;
}
