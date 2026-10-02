import { fromProviderExternalThreadName } from "@bb/domain";
import type { RunnerThreadEvent } from "@bb/runner";
import { appendEvents } from "../db/events.js";
import { getThread, patchThread, type ThreadRow } from "../db/threads.js";
import type { Outbox } from "./core.js";
import type { Engine } from "./engine.js";
import { interruptAll } from "./interactions.js";

type EventOf<Type extends RunnerThreadEvent["type"]> = Extract<
  RunnerThreadEvent,
  { type: Type }
>;

const FATAL_SYSTEM_ERROR_CODES = [
  "provider_process_exited",
  "provider_turn_start_timeout",
];
const PROVIDER_EXIT_REASON =
  "Provider process exited while awaiting user interaction; retry the " +
  "thread to continue";
const TURN_ENDED_REASON = "The turn ended before the interaction was resolved";
const STOPPED_REASON = "Thread stopped by user request";

function isRunnerAuthored(event: RunnerThreadEvent) {
  const { type } = event;
  if (type === "system/error") return true;
  return !type.startsWith("client/") && !type.startsWith("system/");
}

function changesBackgroundActivity(event: RunnerThreadEvent) {
  if (!("item" in event) || event.item.type !== "backgroundTask") return false;
  if (event.type !== "item/backgroundTask/progress") return true;
  return event.item.status !== "pending";
}

function onRootTurnStarted(
  engine: Engine,
  out: Outbox,
  thread: ThreadRow,
  turnId: string,
) {
  const runtime = engine.runtimeOf(thread.id);
  const { cancelledStart, pendingStart } = runtime;
  const abandoned =
    cancelledStart !== null &&
    (pendingStart === null || pendingStart === cancelledStart);
  runtime.pendingStart = null;
  runtime.cancelledStart = null;
  patchThread(engine.ctx.db, thread.id, { activeTurnId: turnId }, false);
  if (abandoned) {
    out.after(() =>
      engine.tell(thread, "interrupt turn", (runner, threadId) =>
        runner.interruptTurn({ threadId }),
      ),
    );
    return;
  }
  engine.transition(out, thread.id, "run.started");
  out.after(() => engine.scheduleDrain(thread.id));
}

function onTurnCompleted(
  engine: Engine,
  out: Outbox,
  thread: ThreadRow,
  event: EventOf<"turn/completed">,
) {
  const { scope, status } = event;
  if (scope.kind !== "turn" || scope.turnId !== thread.activeTurnId) return;
  patchThread(engine.ctx.db, thread.id, { activeTurnId: null }, false);
  const stopped = status === "interrupted" && thread.status === "stopping";
  const reason = stopped ? STOPPED_REASON : TURN_ENDED_REASON;
  if (status !== "completed") interruptAll(engine, out, thread, reason);
  const outcome = engine.transition(
    out,
    thread.id,
    status === "failed"
      ? "run.failed"
      : thread.status === "stopping"
        ? "stop.settled"
        : "run.succeeded",
  );
  if (!outcome.applied) return;
  if (!stopped) engine.notifyParent(out, outcome.thread, { status });
  if (outcome.thread.status === "idle") {
    out.after(() => engine.scheduleDrain(thread.id));
  }
}

function adoptProviderThread(
  engine: Engine,
  out: Outbox,
  thread: ThreadRow,
  providerThreadId: string,
) {
  if (thread.providerThreadId === providerThreadId) return;
  patchThread(engine.ctx.db, thread.id, { providerThreadId }, false);
  const { title } = thread;
  if (title !== null) out.after(() => engine.renameSession(thread, title));
}

function applyEffect(
  engine: Engine,
  out: Outbox,
  threadId: string,
  event: RunnerThreadEvent,
) {
  const thread = getThread(engine.ctx.db, threadId);
  if (thread === undefined) return;
  switch (event.type) {
    case "thread/identity":
      adoptProviderThread(engine, out, thread, event.providerThreadId);
      return;
    case "thread/name/updated": {
      if (thread.title !== null) return;
      const name = fromProviderExternalThreadName(event.threadName).trim();
      if (name !== "") engine.setTitle(out, thread, name);
      return;
    }
    case "turn/started":
      if (event.scope.kind !== "turn" || event.parentToolCallId) return;
      onRootTurnStarted(engine, out, thread, event.scope.turnId);
      return;
    case "turn/completed":
      onTurnCompleted(engine, out, thread, event);
      return;
    case "system/error": {
      if (!FATAL_SYSTEM_ERROR_CODES.includes(event.code ?? "")) return;
      interruptAll(engine, out, thread, PROVIDER_EXIT_REASON);
      const outcome = engine.transition(out, threadId, "run.failed");
      if (!outcome.applied) return;
      engine.notifyParent(out, outcome.thread, { status: "failed" });
      return;
    }
    default:
  }
}

export function ingestThreadEvents(
  engine: Engine,
  threadId: string,
  events: readonly RunnerThreadEvent[],
): void {
  const { db } = engine.ctx;
  const thread = getThread(db, threadId);
  if (thread === undefined || thread.deletedAt !== null) return;
  engine.commit((out) => {
    const accepted = events.filter(isRunnerAuthored);
    const stored = appendEvents(db, thread, accepted, "runner");
    if (stored.length === 0) return;
    const eventTypes = [...new Set(stored.map((event) => event.type))];
    out.thread(threadId, ["events-appended"], {
      eventTypes,
      ...(stored.some(changesBackgroundActivity)
        ? { backgroundActivityChanged: true }
        : {}),
    });
    for (const event of stored) applyEffect(engine, out, threadId, event);
  });
}
