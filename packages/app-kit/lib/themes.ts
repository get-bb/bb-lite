import {
  builtInThemeCss,
  defaultResolvedCodeTheme,
  isBuiltInThemeId,
  resolveCodeTheme,
  type PluginTheme,
  type ResolvedCodeTheme,
} from "@bb/domain";
import { applyResolvedCodeTheme, previewResolvedCodeTheme } from "./code-theme";

const STYLE_ELEMENT_ID = "bb-app-theme";
const CSS_STORAGE_KEY = "bb.appThemeCss";

let epoch = 0;
let committedCss: string | null = null;
let previewedCss: string | null = null;
const subscribers = new Set<() => void>();

export function subscribeAppThemeChange(callback: () => void): () => void {
  subscribers.add(callback);
  return () => void subscribers.delete(callback);
}

export function getAppThemeEpoch(): number {
  return epoch;
}

function styleElement(): HTMLStyleElement {
  const existing = document.getElementById(STYLE_ELEMENT_ID);
  if (existing instanceof HTMLStyleElement) return existing;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  return document.head.appendChild(style);
}

export function refreshThemeColorMeta(): void {
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  const background = window.getComputedStyle(document.body).backgroundColor;
  if (meta && background && background !== "rgba(0, 0, 0, 0)") {
    meta.content = background;
  }
}

function render(): void {
  const style = styleElement();
  const css = previewedCss ?? committedCss ?? style.textContent;
  if (style.textContent !== css) {
    style.textContent = css;
    epoch += 1;
    for (const callback of subscribers) callback();
  }
  refreshThemeColorMeta();
}

let pluginThemes = new Map<string, PluginTheme>();
const pluginCss = new Map<string, Promise<string>>();
let wanted = { committed: "default", previewed: null as string | null };

export function setPluginThemes(themes: readonly PluginTheme[]): void {
  pluginThemes = new Map(themes.map((theme) => [theme.id, theme]));
  for (const cssUrl of pluginCss.keys()) {
    if (!themes.some((theme) => theme.cssUrl === cssUrl)) {
      pluginCss.delete(cssUrl);
    }
  }
}

function codeThemeFor(themeId: string): ResolvedCodeTheme {
  const declared = pluginThemes.get(themeId)?.codeTheme;
  if (declared == null) return resolveCodeTheme(themeId);
  const { dark, light } = defaultResolvedCodeTheme;
  return { dark: declared.dark ?? dark, light: declared.light ?? light };
}

function cssFor(themeId: string): string | Promise<string> | null {
  if (isBuiltInThemeId(themeId)) return builtInThemeCss[themeId];
  const theme = pluginThemes.get(themeId);
  if (theme === undefined) return null;
  const loading =
    pluginCss.get(theme.cssUrl) ??
    fetch(theme.cssUrl).then((response) =>
      response.ok ? response.text() : Promise.reject(new Error(theme.cssUrl)),
    );
  pluginCss.set(theme.cssUrl, loading);
  loading.catch(() => pluginCss.delete(theme.cssUrl));
  return loading;
}

function remember(css: string): void {
  try {
    if (css) localStorage.setItem(CSS_STORAGE_KEY, css);
    else localStorage.removeItem(CSS_STORAGE_KEY);
  } catch {}
}

function commit(css: string): void {
  committedCss = css;
  render();
  remember(css);
}

export function applyAppTheme(themeId: string): void {
  wanted = { committed: themeId, previewed: null };
  previewedCss = null;
  applyResolvedCodeTheme(codeThemeFor(themeId));
  const css = cssFor(themeId);
  if (css === null) return render();
  if (typeof css === "string") return commit(css);
  render();
  const apply = (loaded: string) => {
    if (wanted.committed === themeId) commit(loaded);
  };
  void css.then(apply, () => undefined);
}

export function previewAppTheme(themeId: string | null): void {
  wanted = { ...wanted, previewed: themeId };
  previewResolvedCodeTheme(themeId === null ? null : codeThemeFor(themeId));
  const css = themeId === null ? null : cssFor(themeId);
  if (css === null || typeof css === "string") {
    previewedCss = css;
    return render();
  }
  const show = (loaded: string) => {
    if (wanted.previewed !== themeId) return;
    previewedCss = loaded;
    render();
  };
  void css.then(show, () => undefined);
}

export function applyCachedAppThemeCss(): void {
  let cached: string | null = null;
  try {
    cached = localStorage.getItem(CSS_STORAGE_KEY);
  } catch {}
  if (!cached) return;
  const style = styleElement();
  if (style !== document.head.lastElementChild)
    document.head.appendChild(style);
  committedCss = cached;
  render();
}
