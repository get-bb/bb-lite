import type { ThreadQueuedMessage } from "@bb/domain";

export const GROUP_DIVIDER_ID = "queued-message-group-divider";

export type QueuedMessageOrderChange =
  | {
      kind: "divider";
      orderedMessages: ThreadQueuedMessage[];
      queuedMessageId: string;
      expectedGroupedPrefixQueuedMessageIds: string[];
    }
  | {
      kind: "row";
      orderedMessages: ThreadQueuedMessage[];
      queuedMessageIds: string[];
    };

export function groupBoundaryIndexOf(
  messages: readonly ThreadQueuedMessage[],
): number {
  const index = messages.findIndex((message) => !message.groupWithNext);
  return index === -1 ? Math.max(0, messages.length - 1) : index;
}

export function combinedQueuedMessageIds(
  messages: readonly ThreadQueuedMessage[],
): string[] {
  const ids = messages.map((message) => message.id);
  if (ids.length < 2) return ids;
  const boundary = groupBoundaryIndexOf(messages);
  return [
    ...ids.slice(0, boundary + 1),
    GROUP_DIVIDER_ID,
    ...ids.slice(boundary + 1),
  ];
}

function leadGroupIds(messages: readonly ThreadQueuedMessage[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    ids.push(message.id);
    if (!message.groupWithNext) break;
  }
  return ids;
}

function arrayMove<Item>(items: readonly Item[], from: number, to: number) {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

export function resolveQueuedMessageDrag({
  activeId,
  overId,
  orderedMessages,
}: {
  activeId: string;
  overId: string;
  orderedMessages: readonly ThreadQueuedMessage[];
}): QueuedMessageOrderChange | null {
  if (activeId === overId) return null;
  const combinedIds = combinedQueuedMessageIds(orderedMessages);
  const oldIndex = combinedIds.indexOf(activeId);
  const newIndex = combinedIds.indexOf(overId);
  if (oldIndex === -1 || newIndex === -1) return null;
  const movedIds = arrayMove(combinedIds, oldIndex, newIndex);
  const byId = new Map(orderedMessages.map((message) => [message.id, message]));
  const nextMessages = movedIds.flatMap((id) => {
    const message = byId.get(id);
    return message ? [message] : [];
  });
  if (activeId === GROUP_DIVIDER_ID) {
    const boundary = Math.max(movedIds.indexOf(GROUP_DIVIDER_ID) - 1, 0);
    const boundaryMessage = nextMessages[boundary];
    if (!boundaryMessage) return null;
    if (boundary === groupBoundaryIndexOf(orderedMessages)) return null;
    return {
      kind: "divider",
      orderedMessages: nextMessages.map((message, index) => ({
        ...message,
        groupWithNext: index < boundary,
      })),
      queuedMessageId: boundaryMessage.id,
      expectedGroupedPrefixQueuedMessageIds: nextMessages
        .slice(0, boundary + 1)
        .map((message) => message.id),
    };
  }
  const queuedMessageIds = nextMessages.map((message) => message.id);
  const previousIds = orderedMessages.map((message) => message.id);
  if (queuedMessageIds.join("\n") === previousIds.join("\n")) return null;
  const lead = leadGroupIds(orderedMessages);
  const keepsLead =
    lead.length > 1 &&
    queuedMessageIds.slice(0, lead.length).every((id) => lead.includes(id));
  return {
    kind: "row",
    orderedMessages: nextMessages.map((message, index) => ({
      ...message,
      groupWithNext: keepsLead && index < lead.length - 1,
    })),
    queuedMessageIds,
  };
}

export function moveQueuedMessage(
  orderedMessages: readonly ThreadQueuedMessage[],
  queuedMessageId: string,
  offset: -1 | 1,
): QueuedMessageOrderChange | null {
  const index = orderedMessages.findIndex(({ id }) => id === queuedMessageId);
  const over = orderedMessages[index + offset];
  if (index === -1 || !over) return null;
  return resolveQueuedMessageDrag({
    activeId: queuedMessageId,
    overId: over.id,
    orderedMessages,
  });
}

export function moveGroupBoundary(
  orderedMessages: readonly ThreadQueuedMessage[],
  offset: -1 | 1,
): QueuedMessageOrderChange | null {
  const combinedIds = combinedQueuedMessageIds(orderedMessages);
  const over = combinedIds[combinedIds.indexOf(GROUP_DIVIDER_ID) + offset];
  if (over === undefined) return null;
  return resolveQueuedMessageDrag({
    activeId: GROUP_DIVIDER_ID,
    overId: over,
    orderedMessages,
  });
}
