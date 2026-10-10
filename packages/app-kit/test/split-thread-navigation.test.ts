import { expect, it } from "vitest";
import {
  paneContentForPathname,
  paneContentRoute,
} from "../views/thread-detail/splitThreadNavigation";

it("decodes a plugin panel sub path and round-trips its route", () => {
  const route = "/plugins/docs/docs/personal/folder/Plan%20Title.md";
  const content = paneContentForPathname(route);
  expect(content).toEqual({
    kind: "plugin-panel",
    pluginId: "docs",
    panelPath: "docs",
    subPath: "personal/folder/Plan Title.md",
  });
  if (content !== null) expect(paneContentRoute(content)).toBe(route);
});
