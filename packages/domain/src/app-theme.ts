import { z } from "zod";

const builtInThemeIdSchema = z.enum([
  "default",
  "nord",
  "dracula",
  "solarized",
  "gruvbox",
  "catppuccin",
]);
export type BuiltInThemeId = z.infer<typeof builtInThemeIdSchema>;

interface BuiltInThemeMeta {
  id: BuiltInThemeId;
  name: string;
  description: string;
}

export const builtInThemes: readonly BuiltInThemeMeta[] = [
  { id: "default", name: "Default", description: "The standard bb look" },
  { id: "nord", name: "Nord", description: "Cool, muted arctic blues" },
  {
    id: "dracula",
    name: "Dracula",
    description: "Dark, high-contrast purple and pink",
  },
  {
    id: "solarized",
    name: "Solarized",
    description: "Balanced light and dark (Schoonover palette)",
  },
  { id: "gruvbox", name: "Gruvbox", description: "Warm retro earth tones" },
  {
    id: "catppuccin",
    name: "Catppuccin",
    description: "Soothing pastel — Latte light, Mocha dark",
  },
];

export const pluginThemeSchema = z.object({
  id: z.string().min(1),
  pluginId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  cssUrl: z.string().min(1),
  codeTheme: z
    .object({ dark: z.string().optional(), light: z.string().optional() })
    .nullable(),
});
export type PluginTheme = z.infer<typeof pluginThemeSchema>;

export function pluginThemeId(pluginId: string, themeId: string): string {
  return `plugin:${pluginId}:${themeId}`;
}

export const BUILTIN_THEME_IDS = builtInThemeIdSchema.options;

export function isBuiltInThemeId(id: string): id is BuiltInThemeId {
  return (BUILTIN_THEME_IDS as readonly string[]).includes(id);
}

export const FAVICON_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
] as const;
export type FaviconColor = (typeof FAVICON_COLORS)[number];

export const faviconColorPreferenceSchema = z.enum([
  "default",
  ...FAVICON_COLORS,
]);
export type FaviconColorPreference = z.infer<
  typeof faviconColorPreferenceSchema
>;

export const defaultFaviconColor: FaviconColorPreference = "default";

export const appThemeSchema = z.object({
  themeId: z.string().min(1),
  faviconColor: faviconColorPreferenceSchema,
});
export type AppTheme = z.infer<typeof appThemeSchema>;

export const defaultAppTheme: AppTheme = {
  themeId: "default",
  faviconColor: defaultFaviconColor,
};
