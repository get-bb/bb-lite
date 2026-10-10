import { settings, type SettingsPage } from "@bb/plugin/app";
import { useMemo } from "react";
import {
  SETTINGS_ROUTE_PATH,
  getSettingsRoutePath,
} from "../../lib/route-paths";
import { slotItems } from "../../plugins/registry";
import { useSlot } from "../../plugins/slots";

export type SettingsNavSection = SettingsPage;
export type SettingsSectionId = string;

const UNORDERED = 1_000;

function ordered(pages: readonly SettingsPage[]): SettingsPage[] {
  return pages
    .map((page, index) => ({ page, index }))
    .sort(
      (a, b) =>
        (a.page.order ?? UNORDERED) - (b.page.order ?? UNORDERED) ||
        a.index - b.index,
    )
    .map(({ page }) => page);
}

export function useSettingsPages(): readonly SettingsPage[] {
  const pages = useSlot(settings.page);
  return useMemo(() => ordered(pages), [pages]);
}

export function isSettingsSectionId(value: string): boolean {
  return slotItems(settings.page).some((page) => page.id === value);
}

export function getSettingsSectionRoutePath(
  sectionId: SettingsSectionId,
): string {
  return sectionId === "general"
    ? SETTINGS_ROUTE_PATH
    : getSettingsRoutePath(sectionId);
}
