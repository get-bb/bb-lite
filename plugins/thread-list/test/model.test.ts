import { expect, it } from "vitest";
import {
  normalizeSidebarSectionOrder,
  reorderSidebarSectionOrder,
} from "@bb/client-core";
import type { PluginSidebarThread } from "@bb/plugin/app";
import {
  buildPinInsertRequest,
  collectSectionThreadDndLookup,
  resolveSectionThreadDropDecision,
} from "../app/dnd/dropDecision.js";
import {
  buildPinnedThreadState,
  buildSectionThreadList,
  getThreadComparator,
  type ThreadNode,
} from "../app/model/thread-tree.js";

let clock = 0;
const activity = { workflows: 0, backgroundAgents: 0, backgroundCommands: 0 };

function thread(
  id: string,
  patch: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  clock += 1;
  const base = {
    id,
    displayTitle: id,
    parentThreadId: null,
    sectionId: null,
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: { ...activity, planMode: 0, goals: 0 },
    isUnread: false,
    pinnedAt: null,
    pinSortKey: null,
    isHidden: false,
    createdAt: clock,
    latestAttentionAt: clock,
  };
  return { ...base, ...patch } as PluginSidebarThread;
}

const ids = (nodes: readonly ThreadNode[] = []) =>
  nodes.map((node) => node.thread.id);
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
];
const pinned = buildPinnedThreadState(threads);
const unpinned = threads.filter(
  (item) => !pinned.effectivePinnedThreadIds.has(item.id),
);
const build = (...sort: Parameters<typeof getThreadComparator>) =>
  buildSectionThreadList(unpinned, getThreadComparator(...sort), sections);

it("groups threads into sections with nested children", () => {
  const { loose, sections: groups } = build("updated");
  const [work, later] = groups;
  expect(ids(loose)).toEqual(["b", "a"]);
  expect(groups.map((section) => section.id)).toEqual(["s1", "s2"]);
  expect(work?.key).toBe("chronological::s1");
  expect(ids(work?.nodes)).toEqual(["d", "c"]);
  expect(ids(work?.nodes[1]?.children)).toEqual(["c2", "c1"]);
  expect(work?.threads.map((item) => item.id)).toEqual(["d", "c", "c2", "c1"]);
  expect(work?.nodes[1]?.childCount).toBe(2);
  expect(work?.activity.hasPendingInteraction).toBe(true);
  expect(work?.activity.hasUnreadSuccess).toBe(false);
  expect(later?.nodes).toEqual([]);
});

it("sorts by the chosen field and direction", () => {
  const work = (...sort: Parameters<typeof getThreadComparator>) =>
    ids(build(...sort).sections[0]?.nodes);
  expect(ids(build("updated", "ascending").loose)).toEqual(["b", "a"]);
  expect(ids(build("created", "ascending").loose)).toEqual(["a", "b"]);
  expect(work("alpha")).toEqual(["d", "c"]);
  expect(work("alpha", "descending")).toEqual(["c", "d"]);
  const renaming = { id: "c", name: "aaa" };
  expect(work("alpha", "ascending", renaming)).toEqual(["c", "d"]);
});

it("orders pinned roots by pinSortKey and pins their descendants", () => {
  expect([...pinned.effectivePinnedThreadIds].sort().join()).toBe(
    "p1,p1a,p2,p3",
  );
  expect(ids(pinned.rootNodes)).toEqual(["p3", "p2", "p1"]);
  expect(ids(pinned.rootNodes[2]?.children)).toEqual(["p1a"]);
});

it("keeps the manual section order", () => {
  const normalize = (storedOrder: string[]) =>
    normalizeSidebarSectionOrder({
      storedOrder,
      entitySectionIds: ["section:s1", "section:s2"],
      legacyEntityAnchor: "sections",
      hasPinnedSection: true,
    });
  const order = normalize(["threads", "section:s2", "section:gone"]);
  expect(normalize(["pinned", "sections", "threads"]).join(" ")).toBe(
    "pinned section:s1 section:s2 threads",
  );
  expect(order).toEqual(["pinned", "threads", "section:s2", "section:s1"]);
  const move = { activeId: "section:s1", overId: "threads", order };
  expect(reorderSidebarSectionOrder(move)).toEqual([
    "pinned",
    "section:s1",
    "threads",
    "section:s2",
  ]);
});

it("turns a drop into pin, section and parent changes", () => {
  const list = build("updated");
  const lookup = collectSectionThreadDndLookup(list, pinned.rootNodes);
  const drop = (activeId: string, overId: string) =>
    resolveSectionThreadDropDecision(lookup, activeId, overId);
  const target = { threadId: "p2", placement: "before" } as const;
  expect(drop("a", "section:s1")).toMatchObject({
    kind: "move",
    update: { threadId: "a", sectionId: "s1" },
  });
  expect(drop("c1", "threads")).toMatchObject({
    update: { threadId: "c1", parentThreadId: null, sectionId: null },
  });
  expect(drop("p2", "threads")).toMatchObject({ kind: "move", unpin: true });
  expect(drop("d", "c")).toMatchObject({ kind: "unchanged" });
  expect(drop("a", "pinned")).toMatchObject({ kind: "pin", pin: true });
  expect(drop("p1", "p3")).toEqual({ kind: "reorder-pinned", overId: "p3" });
  expect(buildPinInsertRequest(lookup, "a", target)).toEqual({
    itemId: "a",
    previousItemId: "p3",
    nextItemId: "p2",
  });
});
