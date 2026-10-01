import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  CUSTOM_CODE_THEME_JSON_MAX_LENGTH,
  CUSTOM_THEME_CSS_MAX_LENGTH,
  codeThemeNameSchema,
  customThemeNameSchema,
  defaultAppTheme,
  formatRegisteredCodeThemeName,
  isBuiltInThemeId,
  isCodeThemeFilePath,
  parseVscodeThemeJson,
  resolveCodeTheme,
  uiCodeThemeDeclarationSchema,
  type AppTheme,
  type AppThemeSelection,
  type DeclaredCodeTheme,
  type DeclaredCodeThemeSlot,
} from "@bb/domain";
import { z } from "zod";

type Side = "dark" | "light";

const CONVENTION_CODE_THEME_FILES = {
  dark: "pierre-dark.json",
  light: "pierre-light.json",
} as const;
const themeManifestSchema = z.object({
  codeTheme: uiCodeThemeDeclarationSchema.optional(),
});

async function readText(path: string, maxLength: number) {
  try {
    const text = await readFile(path, "utf8");
    return text.length > maxLength ? null : text;
  } catch {
    return null;
  }
}

async function readJson(path: string): Promise<unknown> {
  const text = await readText(path, CUSTOM_CODE_THEME_JSON_MAX_LENGTH);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function customThemeCssPath(themesDir: string, name: string): string {
  return join(themesDir, name, "theme.css");
}

export async function readCustomThemeCss(
  themesDir: string,
  name: string,
): Promise<string | null> {
  if (!customThemeNameSchema.safeParse(name).success) return null;
  return readText(
    customThemeCssPath(themesDir, name),
    CUSTOM_THEME_CSS_MAX_LENGTH,
  );
}

export async function listCustomThemes(themesDir: string): Promise<string[]> {
  const entries = await readdir(themesDir).catch((): string[] => []);
  const css = await Promise.all(
    entries.map((name) => readCustomThemeCss(themesDir, name)),
  );
  return entries
    .filter((_name, index) => css[index] !== null)
    .sort((left, right) => left.localeCompare(right));
}

async function declaredSlot(
  themeDir: string,
  name: string,
  side: Side,
  reference: string,
): Promise<DeclaredCodeThemeSlot | undefined> {
  if (!isCodeThemeFilePath(reference)) {
    const named = codeThemeNameSchema.safeParse(reference);
    return named.success ? { name: named.data } : undefined;
  }
  const path = resolve(themeDir, reference);
  if (!path.startsWith(themeDir + sep)) return undefined;
  const file = parseVscodeThemeJson(await readJson(path));
  if (file === null) return undefined;
  return { name: formatRegisteredCodeThemeName(name, side), file };
}

async function readDeclaredCodeTheme(
  themesDir: string,
  name: string,
): Promise<DeclaredCodeTheme | null> {
  const themeDir = resolve(themesDir, name);
  const manifest = themeManifestSchema.safeParse(
    await readJson(join(themeDir, "theme.json")),
  );
  const references = manifest.success ? manifest.data.codeTheme : undefined;
  const declared: DeclaredCodeTheme = {};
  for (const side of ["dark", "light"] as const) {
    const reference = references?.[side] ?? CONVENTION_CODE_THEME_FILES[side];
    const slot = await declaredSlot(themeDir, name, side, reference);
    if (slot !== undefined) declared[side] = slot;
  }
  return declared.dark || declared.light ? declared : null;
}

export async function resolveTheme(
  themesDir: string,
  { themeId, faviconColor }: AppThemeSelection,
): Promise<AppTheme> {
  if (isBuiltInThemeId(themeId)) {
    const resolvedCodeTheme = resolveCodeTheme(null, themeId);
    return { themeId, customCss: null, faviconColor, resolvedCodeTheme };
  }
  const customCss = await readCustomThemeCss(themesDir, themeId);
  if (customCss === null) {
    const resolvedCodeTheme = resolveCodeTheme(null, "default");
    return { ...defaultAppTheme, faviconColor, resolvedCodeTheme };
  }
  const declared = await readDeclaredCodeTheme(themesDir, themeId);
  const resolvedCodeTheme = resolveCodeTheme(declared, themeId);
  return { themeId, customCss, faviconColor, resolvedCodeTheme };
}
