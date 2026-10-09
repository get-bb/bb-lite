import { z } from "zod";

const HEX = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;

const codeThemeSchema = z.object({
  type: z.enum(["light", "dark"]).optional(),
  fg: z.string().optional(),
  colors: z.record(z.string(), z.unknown()).optional(),
  tokenColors: z
    .array(
      z.object({
        scope: z.union([z.string(), z.array(z.string())]).optional(),
        settings: z.object({
          foreground: z.string().optional(),
          background: z.string().optional(),
          fontStyle: z.string().optional(),
        }),
      }),
    )
    .optional(),
});

export interface MonacoThemeData {
  base: "vs" | "vs-dark";
  inherit: boolean;
  rules: { token: string; foreground?: string; fontStyle?: string }[];
  colors: Record<string, string>;
}

const TRANSPARENT = {
  "editor.background": "#00000000",
  "editorGutter.background": "#00000000",
  "minimap.background": "#00000000",
};

function hex(value: string | undefined): string | undefined {
  const digits = value?.match(HEX)?.[1];
  if (digits === undefined) return undefined;
  return digits.length > 4
    ? digits
    : [...digits].map((digit) => digit + digit).join("");
}

export function monacoThemeFor(dark: boolean, data: unknown): MonacoThemeData {
  const base = dark ? "vs-dark" : "vs";
  const parsed = codeThemeSchema.safeParse(data);
  if (!parsed.success) {
    return { base, inherit: true, rules: [], colors: TRANSPARENT };
  }
  const theme = parsed.data;
  const rules: MonacoThemeData["rules"] = [];
  const foreground = hex(theme.fg);
  if (foreground !== undefined) rules.push({ token: "", foreground });
  for (const { scope, settings } of theme.tokenColors ?? []) {
    const color = hex(settings.foreground);
    const fontStyle = settings.fontStyle?.trim() || undefined;
    if (color === undefined && fontStyle === undefined) continue;
    const scopes = typeof scope === "string" ? scope.split(",") : scope;
    for (const token of (scopes ?? [""]).map((entry) => entry.trim())) {
      if (scope !== undefined && token === "") continue;
      rules.push({
        token,
        ...(color === undefined ? {} : { foreground: color }),
        ...(fontStyle === undefined ? {} : { fontStyle }),
      });
    }
  }
  const colors: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.colors ?? {})) {
    if (typeof value === "string" && HEX.test(value) && value.startsWith("#")) {
      colors[key] = value;
    }
  }
  return {
    base,
    inherit: true,
    rules,
    colors: { ...colors, ...TRANSPARENT },
  };
}
