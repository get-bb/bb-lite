import type { ThreadQueuedMessage } from "@bb/domain";
import { expect, it } from "vitest";
import {
  GROUP_DIVIDER_ID,
  combinedQueuedMessageIds,
  moveGroupBoundary,
  moveQueuedMessage,
  resolveQueuedMessageDrag,
} from "../app/components/promptbox/banner/queued-message-order";

function queue(...groups: string[]): ThreadQueuedMessage[] {
  return groups.map(
    (id) =>
      ({
        id: id.replace("+", ""),
        groupWithNext: id.endsWith("+"),
      }) as ThreadQueuedMessage,
  );
}

const ids = (messages: readonly ThreadQueuedMessage[] | undefined) =>
  messages?.map(
    (message) => `${message.id}${message.groupWithNext ? "+" : ""}`,
  );

it("puts the divider after the lead group", () => {
  expect(combinedQueuedMessageIds(queue("a"))).toEqual(["a"]);
  expect(combinedQueuedMessageIds(queue("a", "b"))).toEqual([
    "a",
    GROUP_DIVIDER_ID,
    "b",
  ]);
  expect(combinedQueuedMessageIds(queue("a+", "b", "c"))).toEqual([
    "a",
    "b",
    GROUP_DIVIDER_ID,
    "c",
  ]);
});

it("moves the boundary down and up with the prefix the server checks", () => {
  const down = moveGroupBoundary(queue("a", "b", "c"), 1);
  expect(down).toMatchObject({
    kind: "divider",
    queuedMessageId: "b",
    expectedGroupedPrefixQueuedMessageIds: ["a", "b"],
  });
  expect(ids(down?.orderedMessages)).toEqual(["a+", "b", "c"]);
  const up = moveGroupBoundary(queue("a+", "b", "c"), -1);
  expect(up).toMatchObject({ queuedMessageId: "a" });
  expect(ids(up?.orderedMessages)).toEqual(["a", "b", "c"]);
  expect(moveGroupBoundary(queue("a", "b"), -1)).toBeNull();
  expect(moveGroupBoundary(queue("a+", "b"), 1)).toBeNull();
});

it("reorders rows keeping the lead group only while it stays in front", () => {
  const swapped = moveQueuedMessage(queue("a+", "b", "c"), "b", -1);
  expect(swapped).toMatchObject({ queuedMessageIds: ["b", "a", "c"] });
  expect(ids(swapped?.orderedMessages)).toEqual(["b+", "a", "c"]);
  const broken = moveQueuedMessage(queue("a+", "b", "c"), "c", -1);
  expect(ids(broken?.orderedMessages)).toEqual(["a", "c", "b"]);
  expect(moveQueuedMessage(queue("a", "b"), "a", -1)).toBeNull();
  expect(moveQueuedMessage(queue("a", "b"), "b", 1)).toBeNull();
});

it("ignores drops on the item itself or an unknown target", () => {
  const messages = queue("a", "b");
  expect(
    resolveQueuedMessageDrag({
      activeId: "a",
      overId: "a",
      orderedMessages: messages,
    }),
  ).toBeNull();
  expect(
    resolveQueuedMessageDrag({
      activeId: "a",
      overId: "z",
      orderedMessages: messages,
    }),
  ).toBeNull();
});
