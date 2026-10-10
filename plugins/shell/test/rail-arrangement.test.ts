import { describe, expect, it } from "vitest";
import {
  arrangeRailItems,
  moveRailItem,
  setRailItemVisible,
} from "../app/lib/rail-arrangement";

const NEW_THREAD = "__bb__/new-thread";
const SEARCH = "__bb__/search-threads";
const items = [NEW_THREAD, SEARCH, "a/panel", "b/panel"].map((id) => ({
  id,
}));
const ids = (list: readonly { id: string }[]) => list.map((item) => item.id);

describe("rail arrangement", () => {
  it("keeps the natural order and hides only listed items", () => {
    const result = arrangeRailItems(items, { order: [], hidden: [SEARCH] }, [
      NEW_THREAD,
    ]);
    expect(ids(result.ordered)).toEqual([
      NEW_THREAD,
      SEARCH,
      "a/panel",
      "b/panel",
    ]);
    expect(result.visibleIds).toEqual([NEW_THREAD, "a/panel", "b/panel"]);
  });

  it("follows the stored order and puts new items after it", () => {
    const result = arrangeRailItems(
      [...items, { id: "c/panel" }],
      { order: ["b/panel", "a/panel"], hidden: [] },
      [NEW_THREAD],
    );
    expect(ids(result.ordered)).toEqual([
      NEW_THREAD,
      "b/panel",
      "a/panel",
      SEARCH,
      "c/panel",
    ]);
  });

  it("always shows New thread first even when stored as hidden", () => {
    const result = arrangeRailItems(
      items,
      { order: ["a/panel", NEW_THREAD], hidden: [NEW_THREAD] },
      [NEW_THREAD],
    );
    expect(ids(result.ordered)[0]).toBe(NEW_THREAD);
    expect(result.visibleIds).toContain(NEW_THREAD);
  });

  it("hides and shows an item without duplicating it", () => {
    const hidden = setRailItemVisible(
      { order: [], hidden: [SEARCH] },
      "a/panel",
      false,
    );
    expect(hidden.hidden).toEqual([SEARCH, "a/panel"]);
    const shown = setRailItemVisible(hidden, SEARCH, true);
    expect(shown.hidden).toEqual(["a/panel"]);
    expect(setRailItemVisible(shown, "a/panel", false).hidden).toEqual([
      "a/panel",
    ]);
  });

  it("moves an item within the arrangeable order and clamps at the ends", () => {
    const order = [SEARCH, "a/panel", "b/panel"];
    const preferences = { order: [], hidden: [SEARCH] };
    expect(moveRailItem(preferences, order, "b/panel", -1)).toEqual({
      order: [SEARCH, "b/panel", "a/panel"],
      hidden: [SEARCH],
    });
    expect(moveRailItem(preferences, order, SEARCH, -1)).toEqual({
      order: [],
      hidden: [SEARCH],
    });
  });
});
