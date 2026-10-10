import { expect, it } from "vitest";
import { monacoThemeFor } from "../theme.js";

it("turns a code theme into Monaco rules and colours", () => {
  const theme = monacoThemeFor(true, {
    fg: "#abc",
    colors: { "editor.foreground": "#ffffff", "editor.background": "#111111" },
    tokenColors: [
      { scope: "comment, string", settings: { foreground: "#808080" } },
      { scope: ["keyword"], settings: { fontStyle: "bold" } },
      { settings: { foreground: "not a colour" } },
    ],
  });
  expect(theme.base).toBe("vs-dark");
  expect(theme.rules).toEqual([
    { token: "", foreground: "aabbcc" },
    { token: "comment", foreground: "808080" },
    { token: "string", foreground: "808080" },
    { token: "keyword", fontStyle: "bold" },
  ]);
  expect(theme.colors["editor.foreground"]).toBe("#ffffff");
  expect(theme.colors["editor.background"]).toBe("#00000000");
});

it("falls back to the plain light theme without data", () => {
  expect(monacoThemeFor(false, null)).toMatchObject({ base: "vs", rules: [] });
});
