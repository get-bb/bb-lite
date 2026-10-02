import { expect, it } from "vitest";
import * as core from "@bb/client-core";
import type { PluginSidebarThread } from "@bb/plugin/app";
import * as dnd from "../app/dnd/dropDecision.js";
import {
  buildPinnedThreadState,
  buildSectionThreadList,
  getThreadComparator,
  threadItemThread,
  type ThreadItem,
} from "../app/model/thread-tree.js";

let clock = 0;
const idle = { status: "idle", runtimeStatus: "idle", queuedWork: "none" };
const quiet = { isUnread: false, isHidden: false, environment: null };
const loose = { parentThreadId: null, sectionId: null, pinnedAt: null };
const activity = { workflows: 0, backgroundAgents: 0, backgroundCommands: 0 };
const environment = { id: "env", isWorktree: true, providerId: null };

function thread(id: string, patch: object = {}): PluginSidebarThread {
  clock += 1;
  const base = {
    id,
    displayTitle: id,
    ...idle,
    ...quiet,
    ...loose,
    pinSortKey: null,
    hasPendingInteraction: false,
    activity: { ...activity, planMode: 0, goals: 0 },
    createdAt: clock,
    latestAttentionAt: clock,
  };
  return { ...base, ...patch } as PluginSidebarThread;
}

const ids = (items: readonly ThreadItem[] = []) =>
  items.map((item) => threadItemThread(item).id).join();
const children = (item: ThreadItem | undefined) =>
  item?.kind === "thread" ? item.node.children : [];
const sections = ["s1", "s2"].map((id) => ({ id, name: `Section ${id}` }));
const threads = [
  thread("a"),
  thread("b", { status: "active", runtimeStatus: "active" }),
  thread("c", { sectionId: "s1", displayTitle: "zeta" }),
  thread("c1", { parentThreadId: "c", isUnread: true }),
  thread("c2", { parentThreadId: "c", hasPendingInteraction: true }),
  thread("d", { sectionId: "s1", displayTitle: "alpha" }),
  thread("e", { sectionId: "gone" }),
  thread("f", { isHidden: true }),
  thread("p1", { pinnedAt: 5, pinSortKey: "b" }),
  thread("p1a", { parentThreadId: "p1" }),
  thread("p2", { pinnedAt: 6, pinSortKey: "a", sectionId: "s2" }),
  thread("p3", { pinnedAt: 9 }),
  thread("g1", { environment }),
  thread("g2", { environment }),
];
const pinned = buildPinnedThreadState(threads);
const pinnedIds = pinned.effectivePinnedThreadIds;
const unpinned = threads.filter((item) => !pinnedIds.has(item.id));
const build = (...sort: Parameters<typeof getThreadComparator>) =>
  buildSectionThreadList(unpinned, getThreadComparator(...sort), sections);
const byUpdated = getThreadComparator("updated");
const grouped = buildSectionThreadList(
  unpinned,
  byUpdated,
  [],
  undefined,
  true,
);

it("groups threads into sections with nested children", () => {
  const list = build("updated");
  const [work, later] = list.sections;
  expect(ids(list.loose)).toBe("b,g2,g1,a");
  expect(work?.key).toBe("chronological::s1");
  expect(ids(work?.items)).toBe("d,c");
  expect(ids(children(work?.items[1]))).toBe("c2,c1");
  expect(work?.threads.map((item) => item.id).join()).toBe("d,c,c2,c1");
  expect(work?.activity.hasPendingInteraction).toBe(true);
  expect(work?.activity.hasUnreadSuccess).toBe(false);
  expect(later?.items).toEqual([]);
  expect(ids(grouped.loose)).toBe("b,g2,a");
  expect(grouped.loose[1]?.kind).toBe("environment");
});

it("sorts by the chosen field and direction", () => {
  const work = (...sort: Parameters<typeof getThreadComparator>) =>
    ids(build(...sort).sections[0]?.items);
  expect(ids(build("updated", "ascending").loose)).toBe("b,a,g1,g2");
  expect(ids(build("created", "ascending").loose)).toBe("a,b,g1,g2");
  expect(work("alpha")).toBe("d,c");
  expect(work("alpha", "descending")).toBe("c,d");
  expect(work("alpha", "ascending", { id: "c", name: "aaa" })).toBe("c,d");
});

it("orders pinned roots by pinSortKey and pins their descendants", () => {
  expect([...pinnedIds].sort().join()).toBe("p1,p1a,p2,p3");
  expect(ids(pinned.rootItems)).toBe("p3,p2,p1");
  expect(ids(children(pinned.rootItems[2]))).toBe("p1a");
});

it("keeps the manual section order", () => {
  const normalize = (storedOrder: string[]) =>
    core.normalizeSidebarSectionOrder({
      storedOrder,
      entitySectionIds: ["section:s1", "section:s2"],
      legacyEntityAnchor: "sections",
      hasPinnedSection: true,
    });
  const order = normalize(["threads", "section:s2", "section:gone"]);
  const move = { activeId: "section:s1", overId: "threads", order };
  const defaults = normalize(["pinned", "sections", "threads"]).join();
  expect(defaults).toBe("pinned,section:s1,section:s2,threads");
  expect(order.join()).toBe("pinned,threads,section:s2,section:s1");
  const moved = core.reorderSidebarSectionOrder(move)?.join();
  expect(moved).toBe("pinned,section:s1,threads,section:s2");
});

it("turns a drop into pin, section and parent changes", () => {
  const { rootItems, rootNodes } = pinned;
  const list = build("updated");
  const lookup = dnd.collectSectionThreadDndLookup(list, rootItems, rootNodes);
  const drop = (activeId: string, overId: string) =>
    dnd.resolveSectionThreadDropDecision(lookup, activeId, overId);
  const kinds = (...drops: [string, string][]) =>
    drops.map(([activeId, overId]) => drop(activeId, overId)?.kind).join();
  const row = (threadId: string) => `sidebar:thread-row:${threadId}`;
  const target = { threadId: "p2", placement: "before" } as const;
  expect(drop("a", "section:s1")).toMatchObject({
    kind: "move",
    updates: [{ threadId: "a", sectionId: "s1" }],
  });
  expect(drop("c1", "threads")).toMatchObject({
    updates: [{ threadId: "c1", parentThreadId: null, sectionId: null }],
  });
  expect(drop("p2", "threads")).toMatchObject({ unpinThreadIds: ["p2"] });
  expect(drop("a", "pinned")).toMatchObject({ pinThreadIds: ["a"] });
  expect(drop("a", row("d"))).toMatchObject({
    kind: "nest",
    updates: [{ threadId: "a", parentThreadId: "d", sectionId: "s1" }],
  });
  expect(
    kinds(["a", "pinned"], ["d", "c"], ["p1", "p3"], ["c", row("c1")]),
  ).toBe("pin,unchanged,reorder-pinned,rejected");
  expect(dnd.buildPinInsertRequests(lookup, ["a"], target)).toEqual([
    { itemId: "a", previousItemId: "p3", nextItemId: "p2" },
  ]);
});
