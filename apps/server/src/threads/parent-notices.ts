import type {
  ChildThreadOutcome,
  PendingInteraction,
  PromptInput,
  PromptTextMention,
  QueuedMessageSystemNotice,
  ThreadEventTurnStatus,
} from "@bb/domain";
import { lastAssistantText } from "../db/events.js";
import { getThread, type ThreadRow } from "../db/threads.js";
import { dispatchMessage } from "./dispatch.js";
import type { Engine } from "./engine.js";
import { resolveTurnExecution } from "./execution.js";

export interface ChildOutcome {
  status: ThreadEventTurnStatus;
  failureContext?: string;
  interruption?: ChildThreadOutcome["interruption"];
}

interface OutcomeItem extends ChildOutcome {
  child: ThreadRow;
  output: string | null;
}

export interface NoticeBatch {
  items: OutcomeItem[];
  dueAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface SystemNotice extends QueuedMessageSystemNotice {
  input: PromptInput[];
}

type Segment = string | ThreadRow;

export const NOTICE_BATCH_DELAY_MS = 2_000;
const SYSTEM_PREFIX = "[bb system]\n\n";
const OUTPUT_EXCERPT_MAX_CHARS = 4_000;
const OUTPUT_TRUNCATION_MARKER = "\n\n[... output truncated ...]";
const REVIEW_GUIDANCE = "Review the thread before deciding next steps.";
const BLOCKER_GUIDANCE =
  "Review the blocker. If you can resolve it from existing context, reply to the thread with guidance. Otherwise, ask the user for the missing decision.";
const BLOCKER_FALLBACK = "It is blocked on a pending interaction.";
const BLOCKER_MAX_LINES = 4;
const BLOCKER_MAX_CHARS = 700;

function label(thread: ThreadRow): string {
  return thread.title?.trim() || thread.id;
}

function compose(segments: Segment[]): PromptInput[] {
  let text = SYSTEM_PREFIX;
  const mentions: PromptTextMention[] = [];
  for (const segment of segments) {
    if (typeof segment === "string") {
      text += segment;
      continue;
    }
    const start = text.length;
    text += `@thread:${segment.id}`;
    const { id: threadId, projectId } = segment;
    const kind = "thread" as const;
    const resource = { kind, threadId, projectId, label: label(segment) };
    mentions.push({ start, end: text.length, resource });
  }
  return [{ type: "text", text, mentions }];
}

function subjectOf(thread: ThreadRow, outcomes?: ChildThreadOutcome[]) {
  const kind = "thread" as const;
  const base = { kind, threadId: thread.id, threadName: label(thread) };
  return outcomes === undefined ? base : { ...base, outcomes };
}

function interruptionCause(interruption: ChildOutcome["interruption"]) {
  if (interruption?.cause === "host-connection-lost") {
    return " because its host connection was lost";
  }
  const restarted = interruption?.reason === "host-daemon-restarted";
  return restarted ? " because its host daemon restarted" : "";
}

function outcomeLabel(item: OutcomeItem): string {
  if (item.failureContext !== undefined) return item.failureContext;
  if (item.status !== "interrupted") return item.status;
  return `was interrupted${interruptionCause(item.interruption)}`;
}

function outputExcerpt(output: string | null): string {
  const text = output?.trim() ?? "";
  if (text === "") return "No final output was recorded.";
  if (text.length <= OUTPUT_EXCERPT_MAX_CHARS) return text;
  const kept = OUTPUT_EXCERPT_MAX_CHARS - OUTPUT_TRUNCATION_MARKER.length;
  return `${text.slice(0, kept).trimEnd()}${OUTPUT_TRUNCATION_MARKER}`;
}

function outcomeNotice(items: OutcomeItem[]): SystemNotice {
  const outcomes = items.map((item) => ({
    threadId: item.child.id,
    status: item.status,
    ...(item.interruption ? { interruption: item.interruption } : {}),
  }));
  if (items.length > 1) {
    const lines = items.flatMap((item, index): Segment[] => [
      index === 0 ? "\n\n- " : "\n- ",
      item.child,
      ` ${outcomeLabel(item)}.`,
    ]);
    const kind = "thread-batch" as const;
    return {
      input: compose(["Child thread updates:", ...lines]),
      kind: "child-outcome-batch",
      subject: { kind, count: items.length, outcomes },
    };
  }
  const [item] = items;
  const { child, status } = item;
  const body =
    status === "completed"
      ? ` completed:\n\n${outputExcerpt(item.output)}`
      : ` ${outcomeLabel(item)}.\n\n${REVIEW_GUIDANCE}`;
  return {
    input: compose([child, body]),
    kind: `child-${status}`,
    subject: subjectOf(child, outcomes),
  };
}

function deliverNotice(
  engine: Engine,
  parentThreadId: string,
  notice: SystemNotice,
): void {
  const { db } = engine.ctx;
  const { input, kind, subject } = notice;
  engine.later(parentThreadId, "parent notice", async () => {
    const parent = getThread(db, parentThreadId);
    if (parent === undefined || parent.deletedAt !== null) return;
    if (parent.archivedAt !== null) return;
    await dispatchMessage(engine, parentThreadId, {
      message: {
        input,
        execution: resolveTurnExecution(db, parent, {}),
        senderThreadId: null,
        initiator: "system",
        systemNotice: { kind, subject },
      },
      mode: "auto",
      sendAt: null,
      rows: [],
      sendNow: false,
    });
  });
}

function flushBatch(engine: Engine, parentThreadId: string): void {
  const batch = engine.noticeBatches.get(parentThreadId);
  if (batch === undefined) return;
  engine.noticeBatches.delete(parentThreadId);
  clearTimeout(batch.timer);
  deliverNotice(engine, parentThreadId, outcomeNotice(batch.items));
}

export function flushDueNotices(engine: Engine, now: number): void {
  for (const [parentThreadId, batch] of engine.noticeBatches) {
    if (batch.dueAt <= now) flushBatch(engine, parentThreadId);
  }
}

export function queueChildOutcome(
  engine: Engine,
  child: ThreadRow,
  outcome: ChildOutcome,
): void {
  const parentThreadId = child.parentThreadId;
  if (parentThreadId === null || child.originKind !== null) return;
  const { db, now } = engine.ctx;
  const completed = outcome.status === "completed";
  const output = completed ? lastAssistantText(db, child.id) : null;
  const item: OutcomeItem = { ...outcome, child, output };
  const batch = engine.noticeBatches.get(parentThreadId);
  const others = (batch?.items ?? []).filter(
    (entry) =>
      entry.child.id !== child.id ||
      entry.failureContext !== outcome.failureContext,
  );
  clearTimeout(batch?.timer);
  const timer = setTimeout(
    () => flushBatch(engine, parentThreadId),
    NOTICE_BATCH_DELAY_MS,
  );
  timer.unref();
  const dueAt = now() + NOTICE_BATCH_DELAY_MS;
  const items = [...others, item];
  engine.noticeBatches.set(parentThreadId, { items, dueAt, timer });
}

function blockerSummary(interaction: PendingInteraction): string {
  const { payload } = interaction;
  const details =
    payload.kind === "user_question"
      ? payload.questions.map((question) => question.prompt)
      : payload.kind !== "approval"
        ? [payload.title]
        : payload.subject.kind === "command"
          ? [`Command: ${payload.subject.command}`]
          : [];
  const lines = details.map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return BLOCKER_FALLBACK;
  const kind = payload.kind === "approval" ? payload.subject.kind : "request";
  const heading = `Blocked on ${kind.replaceAll("_", " ")}:`;
  const summary = [heading, ...lines.slice(0, BLOCKER_MAX_LINES)].join("\n");
  return summary.slice(0, BLOCKER_MAX_CHARS);
}

export function notifyParentBlocked(
  engine: Engine,
  child: ThreadRow,
  interaction: PendingInteraction,
): void {
  if (child.parentThreadId === null || child.originKind !== null) return;
  const summary = blockerSummary(interaction);
  const body = ` needs help.\n${summary}\n\n${BLOCKER_GUIDANCE}`;
  deliverNotice(engine, child.parentThreadId, {
    input: compose([child, body]),
    kind: "child-needs-attention",
    subject: subjectOf(child),
  });
}
