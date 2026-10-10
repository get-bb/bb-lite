import type { ThemeSwatch } from "./contract.js";

export const BUILTIN_SWATCHES: Record<
  string,
  { light: ThemeSwatch; dark: ThemeSwatch }
> = {
  default: {
    light: {
      canvas: "oklch(1 0 0)",
      sidebar: "color-mix(in oklch, oklch(0.3211 0 0) 2.2%, oklch(1 0 0))",
      card: "oklch(1 0 0)",
      primary: "oklch(0.27 0 0)",
      accent: "oklch(0.55 0.1 250)",
      foreground: "oklch(0.3211 0 0)",
      fontSans: '"Inter Variable", Inter, sans-serif',
      fontMono:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    },
    dark: {
      canvas: "oklch(0.195 0 0)",
      sidebar: "color-mix(in oklch, oklch(0.81 0 0) 4.3%, oklch(0.195 0 0))",
      card: "oklch(0.195 0 0)",
      primary: "oklch(0.82 0 0)",
      accent: "oklch(0.72 0.09 250)",
      foreground: "oklch(0.81 0 0)",
      fontSans: '"Inter Variable", Inter, sans-serif',
      fontMono:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    },
  },
  nord: {
    light: {
      canvas: "#eceff4",
      sidebar: "color-mix(in oklch, #2e3440 2.2%, #eceff4)",
      card: "#eceff4",
      primary: "#5e81ac",
      accent: "#5e81ac",
      foreground: "#2e3440",
      fontSans: '"Inter Variable", Inter, sans-serif',
      fontMono:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    },
    dark: {
      canvas: "#2e3440",
      sidebar: "color-mix(in oklch, #d8dee9 4.3%, #2e3440)",
      card: "#2e3440",
      primary: "#88c0d0",
      accent: "#88c0d0",
      foreground: "#d8dee9",
      fontSans: '"Inter Variable", Inter, sans-serif',
      fontMono:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    },
  },
  dracula: {
    light: {
      canvas: "#f8f8f2",
      sidebar: "color-mix(in oklch, #282a36 2.2%, #f8f8f2)",
      card: "#f8f8f2",
      primary: "#7d5bbe",
      accent: "#1f6f8b",
      foreground: "#282a36",
      fontSans: '"Inter Variable", Inter, sans-serif',
      fontMono:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    },
    dark: {
      canvas: "#282a36",
      sidebar: "color-mix(in oklch, #f8f8f2 4.3%, #282a36)",
      card: "#282a36",
      primary: "#bd93f9",
      accent: "#8be9fd",
      foreground: "#f8f8f2",
      fontSans: '"Inter Variable", Inter, sans-serif',
      fontMono:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    },
  },
  solarized: {
    light: {
      canvas: "#fdf6e3",
      sidebar: "color-mix(in oklch, #073642 2.2%, #fdf6e3)",
      card: "#fdf6e3",
      primary: "#268bd2",
      accent: "#268bd2",
      foreground: "#073642",
      fontSans: '"Inter Variable", Inter, sans-serif',
      fontMono:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    },
    dark: {
      canvas: "#002b36",
      sidebar: "color-mix(in oklch, #93a1a1 4.3%, #002b36)",
      card: "#002b36",
      primary: "#268bd2",
      accent: "#2aa198",
      foreground: "#93a1a1",
      fontSans: '"Inter Variable", Inter, sans-serif',
      fontMono:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    },
  },
  gruvbox: {
    light: {
      canvas: "#fbf1c7",
      sidebar: "color-mix(in oklch, #3c3836 2.2%, #fbf1c7)",
      card: "#fbf1c7",
      primary: "#076678",
      accent: "#076678",
      foreground: "#3c3836",
      fontSans: '"Inter Variable", Inter, sans-serif',
      fontMono:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    },
    dark: {
      canvas: "#282828",
      sidebar: "color-mix(in oklch, #ebdbb2 4.3%, #282828)",
      card: "#282828",
      primary: "#83a598",
      accent: "#83a598",
      foreground: "#ebdbb2",
      fontSans: '"Inter Variable", Inter, sans-serif',
      fontMono:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    },
  },
  catppuccin: {
    light: {
      canvas: "#eff1f5",
      sidebar: "color-mix(in oklch, #4c4f69 2.2%, #eff1f5)",
      card: "#eff1f5",
      primary: "#8839ef",
      accent: "#1e66f5",
      foreground: "#4c4f69",
      fontSans: '"Inter Variable", Inter, sans-serif',
      fontMono:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    },
    dark: {
      canvas: "#1e1e2e",
      sidebar: "color-mix(in oklch, #cdd6f4 4.3%, #1e1e2e)",
      card: "#1e1e2e",
      primary: "#cba6f7",
      accent: "#89b4fa",
      foreground: "#cdd6f4",
      fontSans: '"Inter Variable", Inter, sans-serif',
      fontMono:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    },
  },
};
