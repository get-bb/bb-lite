import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { plugins, server, type PluginServerApi } from "@bb/plugin";
import { builtInThemes } from "@bb/domain";
import { z } from "zod";
import { themePreview, type ThemeSwatch } from "./contract.js";
import { BUILTIN_SWATCHES } from "./swatches.js";

const SWATCH_TOKENS: ReadonlyArray<[keyof ThemeSwatch, readonly string[]]> = [
  ["canvas", ["canvas", "background"]],
  ["sidebar", ["sidebar"]],
  ["card", ["card"]],
  ["primary", ["primary"]],
  ["accent", ["file-accent", "timeline-accent", "ring"]],
  ["foreground", ["foreground"]],
  ["fontSans", ["font-sans"]],
  ["fontMono", ["font-mono"]],
];

const LIGHT = [".light", ".light:not(.dark)", ":root:not(.dark)"];
const DARK = [".dark", ":root.dark", "html.dark"];

export function classifySelector(selector: string) {
  const parts = selector
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const seen = new Set<string>();
  for (const part of parts) {
    if (part === ":root") seen.add("shared");
    else if (LIGHT.includes(part) || part === "html:not(.dark)")
      seen.add("light");
    else if (DARK.includes(part)) seen.add("dark");
    else return null;
  }
  if (seen.has("shared")) return "shared";
  return seen.size === 1 ? (seen.has("dark") ? "dark" : "light") : null;
}

export function parseThemeSwatches(css: string) {
  const declared = { light: new Map<string, string>(), dark: new Map() };
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, selector, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const mode = classifySelector(selector);
    if (!mode) continue;
    for (const [, name, value] of body.matchAll(
      /--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g,
    )) {
      if (mode !== "dark") declared.light.set(name, value.trim());
      if (mode !== "light") declared.dark.set(name, value.trim());
    }
  }
  const resolveToken = (
    name: string,
    tokens: Map<string, string>,
    seen: ReadonlySet<string> = new Set(),
  ): string | null => {
    const value = tokens.get(name);
    if (value === undefined || seen.has(name)) return null;
    const next = new Set(seen).add(name);
    let resolved = value;
    for (let depth = 0; depth < 16 && resolved.includes("var("); depth += 1) {
      const before = resolved;
      resolved = resolved.replace(
        /var\(\s*--([a-zA-Z0-9-]+)(?:\s*,\s*([^()]*))?\s*\)/g,
        (whole, ref: string, fallback: string | undefined) =>
          resolveToken(ref, tokens, next) ?? fallback?.trim() ?? whole,
      );
      if (resolved === before) break;
    }
    return resolved.includes("var(") ? null : resolved;
  };
  const build = (own: Map<string, string>, mode: "light" | "dark") => {
    const base = BUILTIN_SWATCHES.default[mode];
    const tokens = new Map<string, string>();
    for (const [key, names] of SWATCH_TOKENS)
      for (const name of names) tokens.set(name, base[key] ?? "");
    for (const [name, value] of own) tokens.set(name, value);
    const entries = SWATCH_TOKENS.map(([key, names]) => {
      const token = names.find((name) => own.has(name)) ?? names[0];
      return [key, resolveToken(token, tokens) ?? base[key]];
    });
    return Object.fromEntries(entries) as ThemeSwatch;
  };
  return {
    light: build(declared.light, "light"),
    dark: build(declared.dark, "dark"),
  };
}

const manifestSchema = z.object({
  bb: z
    .object({
      themes: z
        .array(z.object({ id: z.string(), css: z.string().optional() }))
        .optional(),
    })
    .optional(),
});

const PLUGIN_THEME = /^plugin:([^:]+):(.+)$/;

export default function themePreviewServer(bb: PluginServerApi): void {
  let revision = 0;
  let watcher: FSWatcher | null = null;
  let watchedPath: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cssPath = async (themeId: string) => {
    const match = PLUGIN_THEME.exec(themeId);
    if (!match) return null;
    const described = await bb.call(plugins.describe, { id: match[1] });
    if (!described) return null;
    const raw = await readFile(resolve(described.directory, "package.json"));
    const manifest = manifestSchema.parse(JSON.parse(raw.toString()));
    const css = manifest.bb?.themes?.find(({ id }) => id === match[2])?.css;
    return css ? resolve(described.directory, css) : null;
  };

  const readCss = async (themeId: string) => {
    try {
      const path = await cssPath(themeId);
      return path ? { path, css: await readFile(path, "utf8") } : null;
    } catch (error) {
      bb.log.warn(`theme-preview: could not read ${themeId}: ${error}`);
      return null;
    }
  };

  const watchActive = (path: string | null) => {
    if (path === watchedPath) return;
    watcher?.close();
    watcher = null;
    watchedPath = path;
    if (!path) return;
    try {
      watcher = watch(path, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          revision += 1;
          watchActive(null);
          bb.changed(themePreview.catalog);
        }, 120);
      });
      watcher.on("error", () => watchActive(null));
    } catch (error) {
      bb.log.warn(`theme-preview: cannot watch ${path}: ${error}`);
    }
  };

  bb.implement(themePreview.catalog, async () => {
    const config = await bb.call(server.config, {});
    const activeThemeId = config.appearance.themeId;
    const entries = [
      ...config.themes.map(({ id, name }) => ({ id, name })),
      ...builtInThemes.map(({ id, name }) => ({ id, name })),
    ];
    if (!entries.some(({ id }) => id === activeThemeId))
      entries.unshift({ id: activeThemeId, name: activeThemeId });
    let activeCss: string | null = null;
    const themes = await Promise.all(
      entries.map(async (entry) => {
        const read = await readCss(entry.id);
        if (entry.id === activeThemeId) {
          activeCss = read?.css ?? null;
          watchActive(read?.path ?? null);
        }
        const swatches = read
          ? parseThemeSwatches(read.css)
          : (BUILTIN_SWATCHES[entry.id] ?? { light: null, dark: null });
        return { ...entry, ...swatches };
      }),
    );
    return { activeThemeId, themes, revision, activeCss };
  });

  bb.background.service("theme-watch", {
    async start(signal) {
      await new Promise((done) =>
        signal.addEventListener("abort", done, { once: true }),
      );
      clearTimeout(timer);
      watchActive(null);
    },
  });
}
