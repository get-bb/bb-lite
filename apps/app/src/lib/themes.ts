import {
  isBuiltInThemeId,
  resolveCodeTheme,
  type BuiltInThemeId,
} from "@bb/domain";
import {
  applyResolvedCodeTheme,
  previewResolvedCodeTheme,
} from "@/lib/code-theme";

const nord = `
:root, .light {
  --canvas: #eceff4; --ink: #2e3440; --primary: #5e81ac;
  --primary-foreground: #eceff4;
  --muted-foreground: color-mix(in oklch, var(--ink) 70%, var(--canvas));
  --subtle-foreground: color-mix(in oklch, var(--ink) 58%, var(--canvas));
  --readback-foreground: color-mix(in oklch, var(--ink) 64%, var(--canvas));
  --timeline-accent: #5e81ac; --file-accent: var(--timeline-accent);
  --destructive: #bf616a; --destructive-text: #a1343d; --warning: #d08770;
  --warning-text: #99543a; --attention: #ebcb8b; --success: #6f9655;
  --diff-added: #5e8a52; --diff-removed: #bf616a; --pr-merged: #9d7cb8;
  --ansi-0: #3b4252; --ansi-1: #bf616a; --ansi-2: #a3be8c; --ansi-3: #ebcb8b;
  --ansi-4: #81a1c1; --ansi-5: #b48ead; --ansi-6: #88c0d0; --ansi-7: #e5e9f0;
  --ansi-8: #4c566a; --ansi-9: #bf616a; --ansi-10: #a3be8c; --ansi-11: #ebcb8b;
  --ansi-12: #81a1c1; --ansi-13: #b48ead; --ansi-14: #8fbcbb;
  --ansi-15: #eceff4; --ansi-bg-fg-0: #ffffff; --ansi-bg-fg-1: #000000;
  --ansi-bg-fg-2: #000000; --ansi-bg-fg-3: #000000; --ansi-bg-fg-4: #000000;
  --ansi-bg-fg-5: #000000; --ansi-bg-fg-6: #000000; --ansi-bg-fg-7: #000000;
  --ansi-bg-fg-8: #ffffff; --ansi-bg-fg-9: #000000; --ansi-bg-fg-10: #000000;
  --ansi-bg-fg-11: #000000; --ansi-bg-fg-12: #000000; --ansi-bg-fg-13: #000000;
  --ansi-bg-fg-14: #000000; --ansi-bg-fg-15: #000000;
}
.dark {
  --canvas: #2e3440; --ink: #d8dee9; --primary: #88c0d0;
  --primary-foreground: #2e3440; --timeline-accent: #88c0d0;
  --file-accent: var(--timeline-accent); --destructive: #bf616a;
  --destructive-text: #d6868d; --warning: #d08770; --warning-text: #e0a48f;
  --attention: #ebcb8b; --success: #a3be8c; --diff-added: #a3be8c;
  --diff-removed: #bf616a; --pr-merged: #b48ead;
}
`;

const dracula = `
:root, .light {
  --canvas: #f8f8f2; --ink: #282a36; --primary: #7d5bbe;
  --primary-foreground: #ffffff;
  --muted-foreground: color-mix(in oklch, var(--ink) 70%, var(--canvas));
  --subtle-foreground: color-mix(in oklch, var(--ink) 58%, var(--canvas));
  --readback-foreground: color-mix(in oklch, var(--ink) 64%, var(--canvas));
  --timeline-accent: #1f6f8b; --file-accent: var(--timeline-accent);
  --destructive: #c4314b; --destructive-text: #b3243d; --warning: #b8762e;
  --warning-text: #8f5a22; --attention: #9a7d00; --success: #2c7a4b;
  --diff-added: #2c7a4b; --diff-removed: #c4314b; --pr-merged: #7d5bbe;
  --ansi-0: #21222c; --ansi-1: #ff5555; --ansi-2: #50fa7b; --ansi-3: #f1fa8c;
  --ansi-4: #bd93f9; --ansi-5: #ff79c6; --ansi-6: #8be9fd; --ansi-7: #f8f8f2;
  --ansi-8: #6272a4; --ansi-9: #ff6e6e; --ansi-10: #69ff94; --ansi-11: #ffffa5;
  --ansi-12: #d6acff; --ansi-13: #ff92df; --ansi-14: #a4ffff;
  --ansi-15: #ffffff; --ansi-bg-fg-0: #ffffff; --ansi-bg-fg-1: #000000;
  --ansi-bg-fg-2: #000000; --ansi-bg-fg-3: #000000; --ansi-bg-fg-4: #000000;
  --ansi-bg-fg-5: #000000; --ansi-bg-fg-6: #000000; --ansi-bg-fg-7: #000000;
  --ansi-bg-fg-8: #ffffff; --ansi-bg-fg-9: #000000; --ansi-bg-fg-10: #000000;
  --ansi-bg-fg-11: #000000; --ansi-bg-fg-12: #000000; --ansi-bg-fg-13: #000000;
  --ansi-bg-fg-14: #000000; --ansi-bg-fg-15: #000000;
}
.dark {
  --canvas: #282a36; --ink: #f8f8f2; --primary: #bd93f9;
  --primary-foreground: #282a36; --timeline-accent: #8be9fd;
  --file-accent: var(--timeline-accent); --destructive: #ff5555;
  --destructive-text: #ff7b7b; --warning: #ffb86c; --warning-text: #ffb86c;
  --attention: #f1fa8c; --success: #50fa7b; --diff-added: #50fa7b;
  --diff-removed: #ff5555; --pr-merged: #bd93f9;
}
`;

const solarized = `
:root, .light {
  --canvas: #fdf6e3; --ink: #073642; --primary: #268bd2;
  --primary-foreground: #fdf6e3;
  --muted-foreground: color-mix(in oklch, var(--ink) 70%, var(--canvas));
  --subtle-foreground: color-mix(in oklch, var(--ink) 58%, var(--canvas));
  --readback-foreground: color-mix(in oklch, var(--ink) 64%, var(--canvas));
  --timeline-accent: #268bd2; --file-accent: var(--timeline-accent);
  --destructive: #dc322f; --destructive-text: #c12321; --warning: #cb4b16;
  --warning-text: #a53c12; --attention: #b58900; --success: #718c00;
  --diff-added: #718c00; --diff-removed: #dc322f; --pr-merged: #6c71c4;
  --ansi-0: #073642; --ansi-1: #dc322f; --ansi-2: #859900; --ansi-3: #b58900;
  --ansi-4: #268bd2; --ansi-5: #d33682; --ansi-6: #2aa198; --ansi-7: #eee8d5;
  --ansi-8: #586e75; --ansi-9: #cb4b16; --ansi-10: #93a1a1; --ansi-11: #839496;
  --ansi-12: #657b83; --ansi-13: #6c71c4; --ansi-14: #2aa198;
  --ansi-15: #fdf6e3; --ansi-bg-fg-0: #ffffff; --ansi-bg-fg-1: #ffffff;
  --ansi-bg-fg-2: #000000; --ansi-bg-fg-3: #000000; --ansi-bg-fg-4: #000000;
  --ansi-bg-fg-5: #000000; --ansi-bg-fg-6: #000000; --ansi-bg-fg-7: #000000;
  --ansi-bg-fg-8: #ffffff; --ansi-bg-fg-9: #ffffff; --ansi-bg-fg-10: #000000;
  --ansi-bg-fg-11: #000000; --ansi-bg-fg-12: #000000; --ansi-bg-fg-13: #000000;
  --ansi-bg-fg-14: #000000; --ansi-bg-fg-15: #000000;
}
.dark {
  --canvas: #002b36; --ink: #93a1a1; --primary: #268bd2;
  --primary-foreground: #002b36; --timeline-accent: #2aa198;
  --file-accent: var(--timeline-accent); --destructive: #dc322f;
  --destructive-text: #e8645f; --warning: #cb4b16; --warning-text: #e07a4e;
  --attention: #b58900; --success: #859900; --diff-added: #859900;
  --diff-removed: #dc322f; --pr-merged: #6c71c4;
}
`;

const gruvbox = `
:root, .light {
  --canvas: #fbf1c7; --ink: #3c3836; --primary: #076678;
  --primary-foreground: #fbf1c7;
  --muted-foreground: color-mix(in oklch, var(--ink) 70%, var(--canvas));
  --subtle-foreground: color-mix(in oklch, var(--ink) 58%, var(--canvas));
  --readback-foreground: color-mix(in oklch, var(--ink) 64%, var(--canvas));
  --timeline-accent: #076678; --file-accent: var(--timeline-accent);
  --destructive: #cc241d; --destructive-text: #9d0006; --warning: #d65d0e;
  --warning-text: #af3a03; --attention: #b57614; --success: #79740e;
  --diff-added: #79740e; --diff-removed: #9d0006; --pr-merged: #8f3f71;
  --ansi-0: #3c3836; --ansi-1: #cc241d; --ansi-2: #98971a; --ansi-3: #d79921;
  --ansi-4: #458588; --ansi-5: #b16286; --ansi-6: #689d6a; --ansi-7: #ebdbb2;
  --ansi-8: #928374; --ansi-9: #fb4934; --ansi-10: #b8bb26; --ansi-11: #fabd2f;
  --ansi-12: #83a598; --ansi-13: #d3869b; --ansi-14: #8ec07c;
  --ansi-15: #fbf1c7; --ansi-bg-fg-0: #ffffff; --ansi-bg-fg-1: #ffffff;
  --ansi-bg-fg-2: #000000; --ansi-bg-fg-3: #000000; --ansi-bg-fg-4: #000000;
  --ansi-bg-fg-5: #000000; --ansi-bg-fg-6: #000000; --ansi-bg-fg-7: #000000;
  --ansi-bg-fg-8: #000000; --ansi-bg-fg-9: #000000; --ansi-bg-fg-10: #000000;
  --ansi-bg-fg-11: #000000; --ansi-bg-fg-12: #000000; --ansi-bg-fg-13: #000000;
  --ansi-bg-fg-14: #000000; --ansi-bg-fg-15: #000000;
}
.dark {
  --canvas: #282828; --ink: #ebdbb2; --primary: #83a598;
  --primary-foreground: #282828; --timeline-accent: #83a598;
  --file-accent: var(--timeline-accent); --destructive: #fb4934;
  --destructive-text: #fb4934; --warning: #fe8019; --warning-text: #fe8019;
  --attention: #fabd2f; --success: #b8bb26; --diff-added: #b8bb26;
  --diff-removed: #fb4934; --pr-merged: #d3869b;
}
`;

const catppuccin = `
:root, .light {
  --canvas: #eff1f5; --ink: #4c4f69; --primary: #8839ef;
  --primary-foreground: #eff1f5; --timeline-accent: #1e66f5;
  --file-accent: var(--timeline-accent); --muted-foreground: #5c5f77;
  --readback-foreground: #6c6f85; --subtle-foreground: #8c8fa1;
  --destructive: #d20f39; --destructive-foreground: #eff1f5;
  --destructive-text: #d20f39; --warning: #df8e1d; --warning-text: #b8730a;
  --attention: #fe640b; --success: #40a02b; --diff-added: #40a02b;
  --diff-removed: #d20f39; --pr-merged: #8839ef; --ansi-0: #5c5f77;
  --ansi-bg-fg-0: #eff1f5; --ansi-1: #d20f39; --ansi-bg-fg-1: #eff1f5;
  --ansi-2: #40a02b; --ansi-bg-fg-2: #eff1f5; --ansi-3: #df8e1d;
  --ansi-bg-fg-3: #11111b; --ansi-4: #1e66f5; --ansi-bg-fg-4: #eff1f5;
  --ansi-5: #ea76cb; --ansi-bg-fg-5: #11111b; --ansi-6: #179299;
  --ansi-bg-fg-6: #eff1f5; --ansi-7: #acb0be; --ansi-bg-fg-7: #11111b;
  --ansi-8: #6c6f85; --ansi-bg-fg-8: #eff1f5; --ansi-9: #d20f39;
  --ansi-bg-fg-9: #eff1f5; --ansi-10: #40a02b; --ansi-bg-fg-10: #eff1f5;
  --ansi-11: #df8e1d; --ansi-bg-fg-11: #11111b; --ansi-12: #1e66f5;
  --ansi-bg-fg-12: #eff1f5; --ansi-13: #ea76cb; --ansi-bg-fg-13: #11111b;
  --ansi-14: #179299; --ansi-bg-fg-14: #eff1f5; --ansi-15: #bcc0cc;
  --ansi-bg-fg-15: #11111b;
}
.dark {
  --canvas: #1e1e2e; --ink: #cdd6f4; --primary: #cba6f7;
  --primary-foreground: #1e1e2e; --timeline-accent: #89b4fa;
  --file-accent: var(--timeline-accent); --muted-foreground: #bac2de;
  --readback-foreground: #a6adc8; --subtle-foreground: #7f849c;
  --destructive: #f38ba8; --destructive-foreground: #1e1e2e;
  --destructive-text: #f38ba8; --warning: #f9e2af; --warning-text: #f9e2af;
  --attention: #fab387; --success: #a6e3a1; --diff-added: #a6e3a1;
  --diff-removed: #f38ba8; --pr-merged: #cba6f7; --ansi-0: #45475a;
  --ansi-bg-fg-0: #cdd6f4; --ansi-1: #f38ba8; --ansi-bg-fg-1: #11111b;
  --ansi-2: #a6e3a1; --ansi-bg-fg-2: #11111b; --ansi-3: #f9e2af;
  --ansi-bg-fg-3: #11111b; --ansi-4: #89b4fa; --ansi-bg-fg-4: #11111b;
  --ansi-5: #f5c2e7; --ansi-bg-fg-5: #11111b; --ansi-6: #94e2d5;
  --ansi-bg-fg-6: #11111b; --ansi-7: #bac2de; --ansi-bg-fg-7: #11111b;
  --ansi-8: #585b70; --ansi-bg-fg-8: #cdd6f4; --ansi-9: #f38ba8;
  --ansi-bg-fg-9: #11111b; --ansi-10: #a6e3a1; --ansi-bg-fg-10: #11111b;
  --ansi-11: #f9e2af; --ansi-bg-fg-11: #11111b; --ansi-12: #89b4fa;
  --ansi-bg-fg-12: #11111b; --ansi-13: #f5c2e7; --ansi-bg-fg-13: #11111b;
  --ansi-14: #94e2d5; --ansi-bg-fg-14: #11111b; --ansi-15: #a6adc8;
  --ansi-bg-fg-15: #11111b;
}
`;

const paletteCss: Record<BuiltInThemeId, string> = {
  default: "",
  nord,
  dracula,
  solarized,
  gruvbox,
  catppuccin,
};
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

function render(): void {
  const style = styleElement();
  const css = previewedCss ?? committedCss ?? style.textContent;
  if (style.textContent !== css) {
    style.textContent = css;
    epoch += 1;
    for (const callback of subscribers) callback();
  }
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  const background = window.getComputedStyle(document.body).backgroundColor;
  if (meta && background && background !== "rgba(0, 0, 0, 0)") {
    meta.content = background;
  }
}

export { render as refreshThemeColorMeta };

function cssFor(themeId: string): string {
  return isBuiltInThemeId(themeId) ? paletteCss[themeId] : "";
}

export function applyAppTheme(themeId: string): void {
  committedCss = cssFor(themeId);
  previewedCss = null;
  applyResolvedCodeTheme(resolveCodeTheme(null, themeId));
  render();
  try {
    if (committedCss) localStorage.setItem(CSS_STORAGE_KEY, committedCss);
    else localStorage.removeItem(CSS_STORAGE_KEY);
  } catch {}
}

export function previewAppTheme(themeId: string | null): void {
  previewedCss = themeId === null ? null : cssFor(themeId);
  previewResolvedCodeTheme(
    themeId === null ? null : resolveCodeTheme(null, themeId),
  );
  render();
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
