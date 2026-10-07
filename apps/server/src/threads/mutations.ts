import {
  createStandaloneBuiltinCompactCommandInput,
  type ThreadChangeKind,
} from "@bb/domain";
import type * as contract from "@bb/server-contract";
import { actorUserId, viewerId } from "../auth/actor.js";
import * as queue from "../db/queued-messages.js";
import { listSidebarThreadRows } from "../db/thread-read.js";
import { requireThreadSection } from "../db/thread-sections.js";
import * as viewerState from "../db/thread-user-state.js";
import * as store from "../db/threads.js";
import { conflict } from "../http/errors.js";
import { requireValidParent } from "./create.js";
import * as dispatching from "./dispatch.js";
import type { Engine } from "./engine.js";
import { resolveTurnExecution } from "./execution.js";
import { toThreadListEntries } from "./thread-display.js";

function toSendResponse(
  outcome: dispatching.Delivery,
): contract.SendMessageResponse {
  if (outcome.delivery === "sent") return { ok: true, delivery: "sent" };
  const queuedMessage = queue.toThreadQueuedMessage(outcome.row);
  return { ok: true, delivery: "queued", queuedMessage };
}

export async function send(
  engine: Engine,
  threadId: string,
  request: contract.SendMessageRequest,
) {
  const thread = engine.requireThread(threadId);
  const senderThreadId = engine.senderOf(thread, request.senderThreadId);
  const outcome = await dispatching.dispatchMessage(engine, threadId, {
    message: {
      input: request.input,
      execution: resolveTurnExecution(engine.ctx.db, thread, request),
      senderThreadId,
      actorUserId: actorUserId(),
      initiator: senderThreadId === null ? "user" : "agent",
      systemNotice: null,
    },
    mode: request.mode,
    sendAt: request.sendAt ?? null,
    rows: [],
    sendNow: false,
  });
  return toSendResponse(outcome);
}

export async function compact(engine: Engine, threadId: string) {
  const thread = engine.requireThread(threadId);
  if (thread.status !== "idle" && thread.status !== "error") {
    const state = "the thread is idle or errored";
    throw conflict(`Context can only be compacted while ${state}`);
  }
  const input = createStandaloneBuiltinCompactCommandInput();
  const request = { input, mode: "start" as const };
  await engine.inThread(threadId, () => send(engine, threadId, request));
}

export function update(
  engine: Engine,
  threadId: string,
  patch: contract.UpdateThreadRequest,
) {
  const { db } = engine.ctx;
  const thread = engine.requireThread(threadId);
  const { parentThreadId, sectionId, title } = patch;
  if (parentThreadId != null) requireValidParent(db, parentThreadId, thread);
  if (sectionId != null) requireThreadSection(db, sectionId);
  const fields: store.ThreadPatch = {};
  if (title !== undefined) fields.title = title;
  if (patch.visibility !== undefined) fields.visibility = patch.visibility;
  if (patch.model !== undefined) fields.modelOverride = patch.model;
  if (patch.reasoningLevel !== undefined) {
    fields.reasoningLevelOverride = patch.reasoningLevel;
  }
  const shared = Object.keys(fields).length > 0 || parentThreadId != null;
  if (shared) engine.assertWritable(thread);
  const changes: ThreadChangeKind[] = [];
  const listed = Object.keys(fields).length > 0 || sectionId !== undefined;
  if (listed) changes.push("title-changed");
  const previousParentId = thread.parentThreadId;
  if (parentThreadId !== undefined && parentThreadId !== previousParentId) {
    fields.parentThreadId = parentThreadId;
    changes.push("parent-changed");
  }
  const updated = engine.commit((out) => {
    const { projectId } = thread;
    if (changes.length > 0) out.thread(threadId, changes, { projectId });
    if (sectionId !== undefined) {
      viewerState.setThreadUserState(db, threadId, viewerId(), { sectionId });
    }
    return store.patchThread(db, threadId, fields);
  });
  if (title != null && title !== thread.title) {
    engine.renameSession(updated, title);
  }
  return engine.respond(threadId);
}

function patchAndAnnounce(
  engine: Engine,
  threadId: string,
  change: ThreadChangeKind,
  patch: Partial<viewerState.ThreadUserState>,
) {
  const { db } = engine.ctx;
  const { projectId } = engine.requireThread(threadId);
  engine.commit((out) => {
    out.thread(threadId, [change], { projectId });
    viewerState.setThreadUserState(db, threadId, viewerId(), patch);
  });
  return engine.respond(threadId);
}

export function pin(engine: Engine, threadId: string) {
  const { db, now } = engine.ctx;
  engine.requireThread(threadId);
  const userId = viewerId();
  const state = viewerState.getThreadUserState(db, threadId, userId);
  const pinned = state !== undefined && state.pinnedAt !== null;
  const pinSortKey = viewerState.nextPinSortKey(db, userId);
  const pinning = { pinnedAt: now(), pinSortKey };
  const change = "pin-state-changed";
  return patchAndAnnounce(engine, threadId, change, pinned ? {} : pinning);
}

export function unpin(engine: Engine, threadId: string) {
  const cleared = { pinnedAt: null, pinSortKey: null };
  return patchAndAnnounce(engine, threadId, "pin-state-changed", cleared);
}

export function reorderPinned(
  engine: Engine,
  threadId: string,
  request: contract.ReorderPinnedThreadRequest,
) {
  const { db, hub } = engine.ctx;
  const { projectId } = engine.requireThread(threadId);
  const { previousThreadId, nextThreadId } = request;
  const userId = viewerId();
  const order = [previousThreadId, nextThreadId] as const;
  viewerState.reorderPinnedThread(db, userId, threadId, ...order);
  hub.thread(threadId, ["pin-state-changed"], { projectId });
  const key = (row: store.ThreadRow) => row.pinSortKey ?? "";
  const pinned = listSidebarThreadRows(db)
    .filter((row) => row.pinnedAt !== null && row.parentThreadId === null)
    .sort((left, right) => (key(left) < key(right) ? -1 : 1));
  return toThreadListEntries(engine.ctx, pinned);
}

export function markRead(engine: Engine, threadId: string) {
  const read = { lastReadAt: engine.ctx.now() };
  return patchAndAnnounce(engine, threadId, "read-state-changed", read);
}

export function markUnread(engine: Engine, threadId: string) {
  const unread = { lastReadAt: null };
  return patchAndAnnounce(engine, threadId, "read-state-changed", unread);
}

function requireQueuedMessage(engine: Engine, threadId: string, id: string) {
  const row = queue.getQueuedMessage(engine.ctx.db, threadId, id);
  if (row !== undefined) return row;
  throw queue.queuedMessageNotFound();
}

function queueChanged(engine: Engine, threadId: string) {
  engine.ctx.hub.thread(threadId, ["queue-changed"]);
}

export function createQueuedMessage(
  engine: Engine,
  threadId: string,
  request: contract.CreateQueuedMessageRequest,
) {
  const { db } = engine.ctx;
  const thread = engine.requireUnarchived(threadId);
  const stopping = thread.status === "stopping";
  const row = queue.insertQueuedMessage(db, {
    threadId,
    content: request.input,
    senderThreadId: engine.senderOf(thread, request.senderThreadId),
    requestedByUserId: actorUserId(),
    systemNotice: null,
    ...resolveTurnExecution(db, thread, request),
    waitingOn: { kind: stopping ? "stopping" : "thread-busy" },
    sendAt: null,
  });
  queueChanged(engine, threadId);
  if (thread.status === "idle") engine.scheduleDrain(threadId);
  return queue.toThreadQueuedMessage(row);
}

export function updateQueuedMessage(
  engine: Engine,
  threadId: string,
  queuedMessageId: string,
  request: contract.UpdateQueuedMessageRequest,
) {
  engine.requireUnarchived(threadId);
  const row = requireQueuedMessage(engine, threadId, queuedMessageId);
  if (row.updatedAt !== request.expectedUpdatedAt) {
    throw conflict("Queued message changed since editing began");
  }
  queue.updateQueuedMessageContent(engine.ctx.db, row, request.input);
  queueChanged(engine, threadId);
  const updated = requireQueuedMessage(engine, threadId, queuedMessageId);
  return queue.toThreadQueuedMessage(updated);
}

export function deleteQueuedMessage(
  engine: Engine,
  threadId: string,
  queuedMessageId: string,
): void {
  requireQueuedMessage(engine, threadId, queuedMessageId);
  queue.deleteQueuedMessages(engine.ctx.db, [queuedMessageId]);
  queueChanged(engine, threadId);
}

export async function sendQueuedMessageNow(
  engine: Engine,
  threadId: string,
  queuedMessageId: string,
  mode: contract.SendQueuedMessageMode,
) {
  engine.requireUnarchived(threadId);
  const id = queuedMessageId;
  const sent = dispatching.sendQueuedMessageNow(engine, threadId, id, mode);
  return toSendResponse(await sent);
}
