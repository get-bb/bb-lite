import {
  type ThreadEventType,
  toPositiveNumber,
  type ContextSnapshot,
  promptInputHasCommandMention,
  requireThreadEventScopeTurnId,
  removeCommandMentionsFromPromptInput,
  type ProviderComposerCommand,
  type Thread,
  type ThreadTimelineActivePromptMode,
  LEGACY_CODEX_GOAL_EXTENSION_KIND,
  threadTimelineGoalStatusSchema,
  type ThreadEvent,
  type ThreadTimelineGoal,
  type ThreadTimelineModelFallback,
  type ThreadEventPlanStep,
  type ThreadTimelinePendingTodoItem,
  type ThreadTimelinePendingTodoItemStatus,
  type ThreadTimelinePendingTodos,
} from "@bb/domain";
import {
  createBufferedTextInstanceKey,
  resolveBufferedTextIdentity,
} from "./text-projection.js";
import {
  type ThreadEventWithMeta,
  getOrderedThreadEvents,
} from "./group-event-projection-turns.js";
import type { ThreadContextWindowUsage } from "@bb/server-contract";
import { parsePromptInput } from "./user-message-parsing.js";
import { z } from "zod";
import { sliceUtf16Head } from "@bb/text-utils";

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
  let agentMessageDeltaCount = 0;
  const completedAssistantKeys = new Set<string>();
  for (const eventWithMeta of events) {
    const { event } = eventWithMeta;
    if (event.type === "item/agentMessage/delta") {
      agentMessageDeltaCount += 1;
      continue;
    }
    if (event.type === "item/completed" && event.item.type === "agentMessage") {
      const identity = resolveBufferedTextIdentity({
        decoded: event,
        kind: "assistant",
      });
      if (identity) {
        completedAssistantKeys.add(createBufferedTextInstanceKey(identity));
      }
    }
  }
  if (
    agentMessageDeltaCount < MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION ||
    completedAssistantKeys.size === 0
  ) {
    return events;
  }
  const retainedCompletedDeltaKeys = new Set<string>();
  const compactedEvents: ThreadEventWithMeta[] = [];
  for (const eventWithMeta of events) {
    const { event } = eventWithMeta;
    if (event.type !== "item/agentMessage/delta") {
      compactedEvents.push(eventWithMeta);
      continue;
    }
    const identity = resolveBufferedTextIdentity({
      decoded: event,
      kind: "assistant",
    });
    if (!identity) {
      compactedEvents.push(eventWithMeta);
      continue;
    }
    const assistantKey = createBufferedTextInstanceKey(identity);
    if (!completedAssistantKeys.has(assistantKey)) {
      compactedEvents.push(eventWithMeta);
      continue;
    }
    if (retainedCompletedDeltaKeys.has(assistantKey)) continue;
    retainedCompletedDeltaKeys.add(assistantKey);
    compactedEvents.push(eventWithMeta);
  }
  return compactedEvents;
}

function toNonNegativeNumber(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

function decodeContextWindowSignal(eventWithMeta: ThreadEventWithMeta): {
  snapshot: ContextSnapshot | undefined;
  estimated: boolean;
  modelContextWindow: number | null;
  usedTokens: number | null;
} | null {
  const { event } = eventWithMeta;
  if (event.type !== "thread/contextWindowUsage/updated") return null;
  const { contextWindowUsage } = event;
  return {
    snapshot: contextWindowUsage.snapshot,
    usedTokens:
      contextWindowUsage.usedTokens === null
        ? null
        : toNonNegativeNumber(contextWindowUsage.usedTokens),
    modelContextWindow:
      contextWindowUsage.modelContextWindow === null
        ? null
        : (toPositiveNumber(contextWindowUsage.modelContextWindow) ?? null),
    estimated: contextWindowUsage.estimated,
  };
}

function getOrderedContextWindowEvents(
  events: readonly ThreadEventWithMeta[],
): readonly ThreadEventWithMeta[] {
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1].meta.seq > events[index].meta.seq) {
      return [...events].sort((left, right) => left.meta.seq - right.meta.seq);
    }
  }
  return events;
}

export function extractThreadContextWindowUsage(
  events: readonly ThreadEventWithMeta[],
): ThreadContextWindowUsage | null {
  let snapshot: ContextSnapshot | undefined;
  let estimated: boolean | undefined;
  let modelContextWindow: number | undefined;
  let usedTokens: number | undefined;
  let usageIsUnknown = false;
  const orderedEvents = getOrderedContextWindowEvents(events);
  for (let index = orderedEvents.length - 1; index >= 0; index -= 1) {
    const signal = decodeContextWindowSignal(orderedEvents[index]);
    if (!signal) continue;
    if (usedTokens === undefined && !usageIsUnknown) {
      snapshot = signal.snapshot;
      if (signal.usedTokens === null) {
        usageIsUnknown = true;
        estimated = signal.estimated;
      } else {
        usedTokens = signal.usedTokens;
        estimated = signal.estimated;
      }
    }
    if (
      modelContextWindow === undefined &&
      signal.modelContextWindow !== null
    ) {
      modelContextWindow = signal.modelContextWindow;
    }
    if (
      (usedTokens !== undefined || usageIsUnknown) &&
      modelContextWindow !== undefined
    ) {
      break;
    }
  }
  if (usedTokens === undefined || modelContextWindow === undefined) return null;
  return {
    ...(snapshot &&
    snapshot.usedTokens === usedTokens &&
    snapshot.contextWindowTokens === modelContextWindow
      ? { snapshot }
      : {}),
    estimated: estimated ?? false,
    modelContextWindow,
    usedTokens,
  };
}

export type PlanCommand = Pick<ProviderComposerCommand, "trigger" | "name">;

interface ActiveTurnInput {
  request: Extract<
    ThreadEventWithMeta["event"],
    { type: "client/turn/requested" }
  >;
  seq: number;
  turnId: string;
}

export interface ThreadTimelineActivePlanTurn {
  promptMode: ThreadTimelineActivePromptMode;
  turnId: string;
}

function promptTextWithoutPlanCommand(
  request: ActiveTurnInput["request"],
  planCommand: PlanCommand,
): string {
  const cleanedInput = removeCommandMentionsFromPromptInput(
    request.input,
    planCommand,
  );
  return parsePromptInput(cleanedInput)?.text.trim() ?? "";
}

function extractActiveTurnInputs(
  events: readonly ThreadEventWithMeta[],
): ActiveTurnInput[] {
  const requestsById = new Map<
    string,
    Extract<ThreadEventWithMeta["event"], { type: "client/turn/requested" }>
  >();
  const completedTurnIds = new Set<string>();
  let latestThreadInterruptionSeq = -1;
  for (const { event, meta } of events) {
    if (event.type === "client/turn/requested") {
      requestsById.set(event.requestId, event);
      continue;
    }
    if (event.type === "turn/completed") {
      completedTurnIds.add(requireThreadEventScopeTurnId(event));
      continue;
    }
    if (event.type === "system/thread/interrupted") {
      latestThreadInterruptionSeq = Math.max(
        latestThreadInterruptionSeq,
        meta.seq,
      );
    }
  }
  return events.flatMap(({ event, meta }) => {
    if (event.type !== "turn/input/accepted") return [];
    if (meta.seq <= latestThreadInterruptionSeq) return [];
    const turnId = requireThreadEventScopeTurnId(event);
    if (completedTurnIds.has(turnId)) return [];
    const request = requestsById.get(event.clientRequestId);
    return request ? [{ request, seq: meta.seq, turnId }] : [];
  });
}

export function extractThreadTimelineActivePlanTurn({
  events,
  planCommand,
  providerId,
  threadStatus,
}: {
  events: readonly ThreadEventWithMeta[];
  planCommand: PlanCommand | null | undefined;
  providerId: string | undefined;
  threadStatus: Thread["status"];
}): ThreadTimelineActivePlanTurn | null {
  if (
    threadStatus !== "active" ||
    providerId === undefined ||
    planCommand === null ||
    planCommand === undefined
  ) {
    return null;
  }
  let latestPlanTurn: ActiveTurnInput | null = null;
  for (const activeTurn of extractActiveTurnInputs(events)) {
    if (!promptInputHasCommandMention(activeTurn.request.input, planCommand)) {
      continue;
    }
    if (!latestPlanTurn || activeTurn.seq > latestPlanTurn.seq) {
      latestPlanTurn = activeTurn;
    }
  }
  return latestPlanTurn
    ? {
        promptMode: {
          mode: "plan",
          providerId,
          prompt: promptTextWithoutPlanCommand(
            latestPlanTurn.request,
            planCommand,
          ),
        },
        turnId: latestPlanTurn.turnId,
      }
    : null;
}

export function extractThreadTimelineActivePromptMode(
  args: Parameters<typeof extractThreadTimelineActivePlanTurn>[0],
): ThreadTimelineActivePromptMode | null {
  return extractThreadTimelineActivePlanTurn(args)?.promptMode ?? null;
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

type GoalSnapshotCandidate =
  | { kind: "updated"; goal: ThreadTimelineGoal; seq: number }
  | { kind: "cleared"; seq: number };

function extractGoalSnapshotCandidate(
  event: ThreadEvent,
  meta: { createdAt: number; seq: number },
): GoalSnapshotCandidate | null {
  if (
    event.type !== "thread/extensionState/updated" ||
    event.kind !== LEGACY_CODEX_GOAL_EXTENSION_KIND
  ) {
    return null;
  }
  const payload = goalStatePayloadSchema.safeParse(event.payload);
  if (!payload.success) return null;
  if (payload.data === null) return { kind: "cleared", seq: meta.seq };
  return {
    kind: "updated",
    seq: meta.seq,
    goal: {
      sourceSeq: meta.seq,
      updatedAt: meta.createdAt,
      objective: payload.data.objective,
      status: payload.data.status,
      tokenBudget: payload.data.tokenBudget,
      tokensUsed: payload.data.tokensUsed,
      timeUsedSeconds: payload.data.timeUsedSeconds,
    },
  };
}

export function extractThreadTimelineGoal(
  events: readonly ThreadEventWithMeta[],
): ThreadTimelineGoal | null {
  let best: GoalSnapshotCandidate | null = null;
  for (const { event, meta } of getOrderedThreadEvents(events)) {
    const candidate = extractGoalSnapshotCandidate(event, meta);
    if (!candidate) continue;
    if (best === null || candidate.seq > best.seq) best = candidate;
  }
  if (best === null || best.kind === "cleared") return null;
  return best.goal;
}

export function getProviderModelFallbackData(event: ThreadEvent): {
  originalModel: string;
  fallbackModel: string;
  reason: "refusal" | "provider";
  message: string;
} | null {
  if (event.type === "provider/modelFallback") {
    return {
      originalModel: event.originalModel,
      fallbackModel: event.fallbackModel,
      reason: event.reason,
      message: event.message,
    };
  }
  return null;
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
      continue;
    }
    const eventFallback = getProviderModelFallbackData(event);
    if (eventFallback === null) continue;
    latestRelevantSeq = meta.seq;
    fallback = {
      sourceSeq: meta.seq,
      detectedAt: meta.createdAt,
      ...eventFallback,
    };
  }
  return fallback;
}

const TODO_TEXT_MAX_LENGTH = 240;

function trimAndTruncate(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= TODO_TEXT_MAX_LENGTH) return trimmed;
  return sliceUtf16Head(trimmed, TODO_TEXT_MAX_LENGTH);
}

interface SnapshotCandidate {
  seq: number;
  createdAt: number;
  items: ThreadTimelinePendingTodoItem[];
}

function todoIdFor(seq: number, index: number): string {
  return `seq:${seq}:${index}`;
}

const PLAN_STEP_TODO_STATUSES: Readonly<
  Record<
    NonNullable<ThreadEventPlanStep["status"]>,
    ThreadTimelinePendingTodoItemStatus
  >
> = {
  pending: "pending",
  active: "in_progress",
  completed: "completed",
  failed: "completed",
};

function extractPlanStepsCandidate(
  event: ThreadEvent,
  meta: { seq: number; createdAt: number },
): SnapshotCandidate | null {
  if (event.type !== "item/completed" || event.item.type !== "planSteps") {
    return null;
  }
  const items: ThreadTimelinePendingTodoItem[] = [];
  for (const [index, step] of event.item.steps.entries()) {
    const text = trimAndTruncate(step.step);
    if (text.length === 0) continue;
    items.push({
      id: todoIdFor(meta.seq, index),
      text,
      status: PLAN_STEP_TODO_STATUSES[step.status ?? "pending"],
    });
  }
  return { seq: meta.seq, createdAt: meta.createdAt, items };
}

export function extractThreadTimelinePendingTodos(
  threadStatus: Thread["status"],
  events: readonly ThreadEventWithMeta[],
): ThreadTimelinePendingTodos | null {
  if (threadStatus !== "active") return null;
  let best: SnapshotCandidate | null = null;
  for (const { event, meta } of getOrderedThreadEvents(events)) {
    const candidate = extractPlanStepsCandidate(event, meta);
    if (!candidate) continue;
    if (best === null || candidate.seq > best.seq) best = candidate;
  }
  if (best === null) return null;
  return { sourceSeq: best.seq, updatedAt: best.createdAt, items: best.items };
}
