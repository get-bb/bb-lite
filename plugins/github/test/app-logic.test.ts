import { describe, expect, it } from "vitest";
import {
  filterItems,
  parseSubPath,
  relativeTime,
  routeToSubPath,
  toggle,
} from "../app/logic.js";
import type { Item } from "../contract.js";

function item(overrides: Partial<Item>): Item {
  return {
    repo: "acme/app",
    number: 1,
    kind: "issue",
    title: "Crash on start",
    state: "open",
    author: "alice",
    labels: [],
    assignees: [],
    url: "https://github.com/acme/app/issues/1",
    body: "",
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

const items = [
  item({ number: 1, labels: ["bug"], assignees: ["Sawyer"] }),
  item({
    number: 2,
    title: "Add dark mode",
    state: "closed",
    updatedAt: "2026-10-05T00:00:00Z",
  }),
  item({
    number: 3,
    repo: "acme/site",
    title: "Typo in footer",
    author: "sawyer",
    updatedAt: "2026-10-03T00:00:00Z",
  }),
];

const numbers = (query: string, viewer: string | null = "sawyer") =>
  filterItems(items, query, viewer).map((entry) => entry.number);

describe("github app logic", () => {
  it("filters by GitHub-style qualifiers and sorts newest first", () => {
    expect(numbers("")).toEqual([2, 3, 1]);
    expect(numbers("is:open ")).toEqual([3, 1]);
    expect(numbers("assignee:@me")).toEqual([1]);
    expect(numbers("assignee:@me", null)).toEqual([]);
    expect(numbers("author:@me")).toEqual([3]);
    expect(numbers("label:BUG")).toEqual([1]);
    expect(numbers("no:label no:assignee")).toEqual([2, 3]);
    expect(numbers("repo:acme/site")).toEqual([3]);
    expect(numbers('"dark mode"')).toEqual([2]);
    expect(numbers("#3")).toEqual([3]);
  });

  it("round-trips panel routes through the sub path", () => {
    for (const route of [
      { view: "issues" },
      { view: "pulls" },
      { view: "new" },
      { view: "issue", repo: "acme/app", number: 7 },
      { view: "pull", repo: "acme/app", number: 9 },
    ] as const) {
      expect(parseSubPath(routeToSubPath(route))).toEqual(route);
    }
    expect(parseSubPath("")).toEqual({ view: "issues" });
    expect(parseSubPath("issues/acme/app/x")).toEqual({ view: "issues" });
  });

  it("toggles values and formats relative times", () => {
    expect(toggle(["a", "b"], "a")).toEqual(["b"]);
    expect(toggle(["a"], "b")).toEqual(["a", "b"]);
    const now = Date.parse("2026-10-09T12:00:00Z");
    expect(relativeTime("2026-10-09T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-10-09T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-10-01T12:00:00Z", now)).toBe("8d ago");
  });
});
