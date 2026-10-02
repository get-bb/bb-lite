import { draculaLightCodeTheme } from "./code-themes/dracula-light.js";
import { nordLightCodeTheme } from "./code-themes/nord-light.js";
import type { JsonObject } from "./json-value.js";

export interface ResolvedCodeTheme {
  dark: string;
  light: string;
}

export const defaultResolvedCodeTheme: ResolvedCodeTheme = {
  dark: "pierre-dark",
  light: "pierre-light",
};

export interface LightCodeTheme {
  name: string;
  displayName: string;
  dark: string;
  swap: Record<string, string>;
  colors: Record<string, string>;
}

export const lightCodeThemes = [nordLightCodeTheme, draculaLightCodeTheme];

const builtInPaletteCodeThemes: Record<string, ResolvedCodeTheme> = {
  default: defaultResolvedCodeTheme,
  nord: { dark: "nord", light: nordLightCodeTheme.name },
  dracula: { dark: "dracula", light: draculaLightCodeTheme.name },
  solarized: { dark: "solarized-dark", light: "solarized-light" },
  gruvbox: { dark: "gruvbox-dark-medium", light: "gruvbox-light-medium" },
  catppuccin: { dark: "catppuccin-mocha", light: "catppuccin-latte" },
};

export function resolveCodeTheme(paletteId = "default"): ResolvedCodeTheme {
  return Object.hasOwn(builtInPaletteCodeThemes, paletteId)
    ? builtInPaletteCodeThemes[paletteId]
    : defaultResolvedCodeTheme;
}

interface DarkTokenRule {
  scope?: string | string[];
  settings: object;
}

export function deriveLightCodeTheme(
  dark: { settings?: readonly DarkTokenRule[] },
  light: LightCodeTheme,
): JsonObject {
  const { colors, displayName, name } = light;
  const tokenColors = (dark.settings ?? []).map(({ scope, settings }) => {
    const recolored = Object.entries(settings).map(([key, value]) => [
      key,
      light.swap[String(value).toLowerCase()] ?? String(value),
    ]);
    return {
      ...(scope === undefined ? {} : { scope }),
      settings: Object.fromEntries(recolored),
    };
  });
  const semanticHighlighting = true;
  const head = { colors, displayName, name, semanticHighlighting };
  return { ...head, tokenColors, type: "light" };
}
