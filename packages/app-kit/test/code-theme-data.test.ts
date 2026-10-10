import { expect, it } from "vitest";
import { codeThemeData } from "../lib/code-theme-data";

it("reduces a resolved code theme to its colours and token rules", () => {
  const raw = {
    name: "ignored",
    type: "dark",
    colors: { "editor.background": "#101010", bad: 3 },
    tokenColors: [
      { scope: ["comment"], settings: { foreground: "#888", fontStyle: 1 } },
      { settings: { background: "#000" } },
      "junk",
    ],
  };
  expect(codeThemeData("/api/theme.json", false, raw)).toEqual({
    name: "/api/theme.json",
    type: "dark",
    colors: { "editor.background": "#101010" },
    tokenColors: [
      { scope: ["comment"], settings: { foreground: "#888" } },
      { settings: { background: "#000" } },
    ],
  });
  const legacy = { settings: [{ scope: "string", settings: {} }] };
  expect(codeThemeData("old", true, legacy)).toMatchObject({
    type: "dark",
    colors: {},
    tokenColors: [{ scope: "string", settings: {} }],
  });
});
