import type { CodeTheme, CodeThemeTokenColor } from "@bb/plugin/app";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};

function tokenColor(value: unknown): CodeThemeTokenColor[] {
  if (typeof value !== "object" || value === null) return [];
  const rule = record(value);
  const scope = rule.scope;
  const settings = record(rule.settings);
  const text = (key: string) =>
    typeof settings[key] === "string" ? { [key]: settings[key] } : {};
  const scoped =
    typeof scope === "string" ||
    (Array.isArray(scope) && scope.every((item) => typeof item === "string"))
      ? { scope }
      : {};
  return [
    {
      ...scoped,
      settings: {
        ...text("foreground"),
        ...text("background"),
        ...text("fontStyle"),
      },
    },
  ];
}

export function codeThemeData(
  name: string,
  dark: boolean,
  raw: unknown,
): CodeTheme {
  const theme = record(raw);
  const colors = Object.entries(record(theme.colors)).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  const rules = theme.tokenColors ?? theme.settings;
  const fallback = dark ? "dark" : "light";
  const declared = theme.type;
  return {
    name,
    type: declared === "light" || declared === "dark" ? declared : fallback,
    colors: Object.fromEntries(colors),
    tokenColors: Array.isArray(rules) ? rules.flatMap(tokenColor) : [],
  };
}
