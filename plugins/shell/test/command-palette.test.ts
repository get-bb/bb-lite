import { expect, it } from "vitest";
import { buildNavigationPaletteActions } from "../app/lib/command-palette.js";

it("names a plugin's settings apart from its settings page", () => {
  const actions = buildNavigationPaletteActions({
    navigate: () => undefined,
    sections: [
      {
        id: "marketplace",
        label: "Marketplace",
        icon: "Store",
        view: () => null,
      },
    ],
    pluginEntries: [
      { id: "marketplace", label: "Marketplace", icon: "Store" },
      { id: "memory", label: "Memory", icon: "Brain" },
    ],
    panels: [],
  });
  const titles = actions.map(({ title }) => title);
  expect(titles).toEqual([
    "Marketplace settings",
    "Marketplace plugin settings",
    "Memory settings",
  ]);
});
