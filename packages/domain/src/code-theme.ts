import { z } from "zod";
import { draculaLightCodeTheme } from "./code-themes/dracula-light.js";
import { nordLightCodeTheme } from "./code-themes/nord-light.js";
import { jsonObjectSchema, type JsonObject } from "./json-value.js";

export const DEFAULT_CODE_THEME_DARK = "pierre-dark";
export const DEFAULT_CODE_THEME_LIGHT = "pierre-light";

export const codeThemeNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/,
    "Code theme names may use letters, digits, '.', '_', ':', and '-' and cannot start with '.'",
  );

const codeThemePairSchema = z
  .object({
    dark: codeThemeNameSchema,
    light: codeThemeNameSchema,
  })
  .strict();
export type CodeThemePair = z.infer<typeof codeThemePairSchema>;

export const resolvedCodeThemeSchema = z
  .object({
    dark: codeThemeNameSchema,
    light: codeThemeNameSchema,
    files: z.record(z.string(), jsonObjectSchema),
  })
  .strict();
export type ResolvedCodeTheme = z.infer<typeof resolvedCodeThemeSchema>;

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

export interface DeclaredCodeThemeSlot {
  name: string;
  file?: JsonObject;
}

export interface DeclaredCodeTheme {
  dark?: DeclaredCodeThemeSlot;
  light?: DeclaredCodeThemeSlot;
}

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

const builtInPaletteCodeThemeFiles: Partial<
  Record<keyof typeof builtInPaletteCodeThemes, Record<string, JsonObject>>
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

export function resolveCodeTheme(
  declared: DeclaredCodeTheme | null,
  paletteId = "default",
): ResolvedCodeTheme {
  const fallback = paletteCodeThemeFallback(paletteId);
  const dark = declared?.dark?.name ?? fallback.dark;
  const light = declared?.light?.name ?? fallback.light;
  const files: Record<string, JsonObject> = {};
  const builtInFiles =
    paletteId in builtInPaletteCodeThemeFiles
      ? builtInPaletteCodeThemeFiles[
          paletteId as keyof typeof builtInPaletteCodeThemeFiles
        ]
      : undefined;
  if (builtInFiles !== undefined) {
    for (const [name, file] of Object.entries(builtInFiles)) {
      if (name === dark || name === light) {
        files[name] = stampRegisteredThemeName(name, file);
      }
    }
  }
  if (declared?.dark?.file !== undefined) {
    files[dark] = stampRegisteredThemeName(dark, declared.dark.file);
  }
  if (declared?.light?.file !== undefined) {
    files[light] = stampRegisteredThemeName(light, declared.light.file);
  }
  return { dark, light, files };
}
