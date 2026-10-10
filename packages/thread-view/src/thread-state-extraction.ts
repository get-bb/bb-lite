import {
  LEGACY_CODEX_GOAL_EXTENSION_KIND,
  threadTimelineGoalStatusSchema,
  toPositiveNumber,
  type Thread,
  type ThreadEventType,
  type ThreadTimelineGoal,
  type ThreadTimelineModelFallback,
  type ThreadTimelinePendingTodos,
} from "@bb/domain";
import type { ThreadContextWindowUsage } from "@bb/server-contract";
import { sliceUtf16Head } from "@bb/text-utils";
import { z } from "zod";
import type { ThreadEventWithMeta } from "./event-projection-types.js";
import { getOrderedThreadEvents } from "./group-event-projection-turns.js";
import { bufferedTextIdentity } from "./text-projection.js";

export const THREAD_TIMELINE_EXCLUDED_EVENT_TYPES = [
  "thread/started",
  "thread/identity",
  "thread/contextWindowUsage/updated",
  "thread/tokenUsage/updated",
  "turn/diff/updated",
] as const satisfies readonly ThreadEventType[];

const MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION = 1000;

export function compactThreadTimelineSummaryEvents(
  events: ThreadEventWithMeta[],
): ThreadEventWithMeta[] {
  const deltas = events.filter(
    ({ event }) => event.type === "item/agentMessage/delta",
  );
  const completedAssistantKeys = new Set(
    events.flatMap(({ event }) =>
      event.type === "item/completed" && event.item.type === "agentMessage"
        ? (bufferedTextIdentity(event)?.key ?? [])
        : [],
    ),
  );
  if (
    deltas.length < MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION ||
    completedAssistantKeys.size === 0
  ) {
    return events;
  }
  const retainedCompletedDeltaKeys = new Set<string>();
  return events.filter(({ event }) => {
    if (event.type !== "item/agentMessage/delta") return true;
    const key = bufferedTextIdentity(event)?.key;
    if (key === undefined || !completedAssistantKeys.has(key)) return true;
    if (retainedCompletedDeltaKeys.has(key)) return false;
    retainedCompletedDeltaKeys.add(key);
    return true;
  });
}

export function extractThreadContextWindowUsage(
  events: readonly ThreadEventWithMeta[],
): ThreadContextWindowUsage | null {
  const signals = getOrderedThreadEvents(events)
    .flatMap(({ event }) =>
      event.type === "thread/contextWindowUsage/updated"
        ? [event.contextWindowUsage]
        : [],
    )
    .reverse();
  const [latest] = signals;
  const usedTokens = latest?.usedTokens ?? -1;
  const modelContextWindow = signals
    .map((signal) => toPositiveNumber(signal.modelContextWindow))
    .find((size) => size !== undefined);
  if (
    !latest ||
    !Number.isFinite(usedTokens) ||
    usedTokens < 0 ||
    modelContextWindow === undefined
  ) {
    return null;
  }
  const { snapshot, estimated } = latest;
  const cost = signals.find((signal) => signal.cost !== undefined)?.cost;
  return {
    ...(cost === undefined ? {} : { cost }),
    ...(snapshot &&
    snapshot.usedTokens === usedTokens &&
    snapshot.contextWindowTokens === modelContextWindow
      ? { snapshot }
      : {}),
    estimated,
    modelContextWindow,
    usedTokens,
  };
}

const goalStatePayloadSchema = z.union([
  z.object({
    objective: z.string(),
    status: threadTimelineGoalStatusSchema,
    tokenBudget: z.number().nullable(),
    tokensUsed: z.number(),
    timeUsedSeconds: z.number(),
  }),
  z.null(),
]);

export function extractThreadTimelineGoal(
  events: readonly ThreadEventWithMeta[],
): ThreadTimelineGoal | null {
  let best: { seq: number; goal: ThreadTimelineGoal | null } | null = null;
  for (const { event, meta } of getOrderedThreadEvents(events)) {
    if (
      event.type !== "thread/extensionState/updated" ||
      event.kind !== LEGACY_CODEX_GOAL_EXTENSION_KIND
    ) {
      continue;
    }
    const payload = goalStatePayloadSchema.safeParse(event.payload);
    if (!payload.success || (best !== null && meta.seq <= best.seq)) continue;
    const goal = payload.data && {
      sourceSeq: meta.seq,
      updatedAt: meta.createdAt,
      ...payload.data,
    };
    best = { seq: meta.seq, goal };
  }
  return best?.goal ?? null;
}

export function extractThreadTimelineModelFallback(
  events: readonly ThreadEventWithMeta[],
): ThreadTimelineModelFallback | null {
  let latestRelevantSeq = -1;
  let fallback: ThreadTimelineModelFallback | null = null;
  for (const { event, meta } of events) {
    if (meta.seq < latestRelevantSeq) continue;
    if (event.type === "client/turn/requested") {
      latestRelevantSeq = meta.seq;
      fallback = null;
    } else if (event.type === "provider/modelFallback") {
      latestRelevantSeq = meta.seq;
      fallback = {
        sourceSeq: meta.seq,
        detectedAt: meta.createdAt,
        originalModel: event.originalModel,
        fallbackModel: event.fallbackModel,
        reason: event.reason,
        message: event.message,
      };
    }
  }
  return fallback;
}

const TODO_TEXT_MAX_LENGTH = 240;

const PLAN_STEP_TODO_STATUSES = {
  pending: "pending",
  active: "in_progress",
  completed: "completed",
  failed: "completed",
} as const;

export function extractThreadTimelinePendingTodos(
  threadStatus: Thread["status"],
  events: readonly ThreadEventWithMeta[],
): ThreadTimelinePendingTodos | null {
  if (threadStatus !== "active") return null;
  let best: ThreadTimelinePendingTodos | null = null;
  for (const { event, meta } of getOrderedThreadEvents(events)) {
    if (
      event.type !== "item/completed" ||
      event.item.type !== "planSteps" ||
      (best !== null && meta.seq <= best.sourceSeq)
    ) {
      continue;
    }
    const items = event.item.steps.flatMap((step, index) => {
      const text = sliceUtf16Head(step.step.trim(), TODO_TEXT_MAX_LENGTH);
      const status = PLAN_STEP_TODO_STATUSES[step.status ?? "pending"];
      const id = `seq:${meta.seq}:${index}`;
      return text.length === 0 ? [] : [{ id, text, status }];
    });
    best = { sourceSeq: meta.seq, updatedAt: meta.createdAt, items };
  }
  return best;
}
