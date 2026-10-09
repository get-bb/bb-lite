import { contract, op } from "@bb/plugin";
import { z } from "zod";

const swatchSchema = z.object({
  canvas: z.string().nullable(),
  sidebar: z.string().nullable(),
  card: z.string().nullable(),
  primary: z.string().nullable(),
  accent: z.string().nullable(),
  foreground: z.string().nullable(),
  fontSans: z.string().nullable(),
  fontMono: z.string().nullable(),
});
export type ThemeSwatch = z.infer<typeof swatchSchema>;

const themeSchema = z.object({
  id: z.string(),
  name: z.string(),
  light: swatchSchema.nullable(),
  dark: swatchSchema.nullable(),
});

export const catalogSchema = z.object({
  activeThemeId: z.string(),
  themes: z.array(themeSchema),
  revision: z.number().int().nonnegative(),
  activeCss: z.string().nullable(),
});
export type ThemeCatalog = z.infer<typeof catalogSchema>;

export const themePreview = contract("theme-preview", {
  catalog: op({ input: z.object({}), output: catalogSchema }),
});
