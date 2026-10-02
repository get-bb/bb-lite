import { draculaLightCodeTheme } from "./code-themes/dracula-light.js";
import { nordLightCodeTheme } from "./code-themes/nord-light.js";
import { type JsonObject } from "./json-value.js";

export const DEFAULT_CODE_THEME_DARK = "pierre-dark";
export const DEFAULT_CODE_THEME_LIGHT = "pierre-light";

interface CodeThemePair {
  dark: string;
  light: string;
}

export interface ResolvedCodeTheme extends CodeThemePair {
  files: Record<string, JsonObject>;
}

export const defaultResolvedCodeTheme: ResolvedCodeTheme = {
  dark: DEFAULT_CODE_THEME_DARK,
  light: DEFAULT_CODE_THEME_LIGHT,
  files: {},
};

export const builtInPaletteCodeThemes = {
  default: {
    dark: DEFAULT_CODE_THEME_DARK,
    light: DEFAULT_CODE_THEME_LIGHT,
  },
  nord: { dark: "nord", light: "bb:nord:light" },
  dracula: { dark: "dracula", light: "bb:dracula:light" },
  solarized: { dark: "solarized-dark", light: "solarized-light" },
  gruvbox: { dark: "gruvbox-dark-medium", light: "gruvbox-light-medium" },
  catppuccin: { dark: "catppuccin-mocha", light: "catppuccin-latte" },
} as const satisfies Record<string, CodeThemePair>;

function paletteCodeThemeFallback(paletteId: string): CodeThemePair {
  if (Object.hasOwn(builtInPaletteCodeThemes, paletteId)) {
    return builtInPaletteCodeThemes[
      paletteId as keyof typeof builtInPaletteCodeThemes
    ];
  }
  return builtInPaletteCodeThemes.default;
}

type TokenRule = [
  scope: string | string[] | null,
  style: string | Record<string, string>,
];

export interface CodeThemeSource {
  displayName: string;
  name: string;
  colors: Record<string, string>;
  rules: TokenRule[];
}

function lightCodeTheme(source: CodeThemeSource): JsonObject {
  const { colors, displayName, name } = source;
  const tokenColors = source.rules.map(([scope, style]) => ({
    ...(scope === null ? {} : { scope }),
    settings: typeof style === "string" ? { foreground: style } : style,
  }));
  const semanticHighlighting = true;
  const head = { colors, displayName, name, semanticHighlighting };
  return { ...head, tokenColors, type: "light" };
}

const builtInPaletteCodeThemeFiles: Record<
  string,
  Record<string, JsonObject>
> = {
  nord: { "bb:nord:light": lightCodeTheme(nordLightCodeTheme) },
  dracula: { "bb:dracula:light": lightCodeTheme(draculaLightCodeTheme) },
};

export function stampRegisteredThemeName(
  name: string,
  file: JsonObject,
): JsonObject {
  if (file.name === name) return file;
  return { ...file, name };
}

export function resolveCodeTheme(paletteId = "default"): ResolvedCodeTheme {
  const pair = paletteCodeThemeFallback(paletteId);
  const builtIn = Object.hasOwn(builtInPaletteCodeThemeFiles, paletteId)
    ? builtInPaletteCodeThemeFiles[paletteId]
    : undefined;
  return { ...pair, files: builtIn ?? {} };
}
