import {
  createStandaloneBuiltinCompactCommandInput,
  type ThreadChangeKind,
} from "@bb/domain";
import type * as contract from "@bb/server-contract";
import { threadSectionExists } from "../db/engine-lookups.js";
import * as queue from "../db/queued-messages.js";
import * as store from "../db/threads.js";
import { ApiError } from "../http/errors.js";
import { conflict } from "./core.js";
import { requireValidParent } from "./create.js";
import * as dispatching from "./dispatch.js";
import type { Engine } from "./engine.js";
import { resolveTurnExecution } from "./execution.js";

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
  const outcome = await engine.dispatch(threadId, {
    message: {
      input: request.input,
      execution: resolveTurnExecution(engine.ctx.db, thread, request),
      senderThreadId,
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
  if (sectionId != null && !threadSectionExists(db, sectionId)) {
    const message = "Thread section not found";
    throw new ApiError(404, "thread_section_not_found", message);
  }
  const fields: store.ThreadPatch = {};
  if (title !== undefined) fields.title = title;
  if (sectionId !== undefined) fields.sectionId = sectionId;
  if (patch.visibility !== undefined) fields.visibility = patch.visibility;
  if (patch.model !== undefined) fields.modelOverride = patch.model;
  if (patch.reasoningLevel !== undefined) {
    fields.reasoningLevelOverride = patch.reasoningLevel;
  }
  const changes: ThreadChangeKind[] = [];
  if (Object.keys(fields).length > 0) changes.push("title-changed");
  const previousParentId = thread.parentThreadId;
  if (parentThreadId !== undefined && parentThreadId !== previousParentId) {
    fields.parentThreadId = parentThreadId;
    changes.push("parent-changed");
    const released = parentThreadId === null && sectionId === undefined;
    const previous =
      previousParentId === null
        ? undefined
        : store.getThread(db, previousParentId);
    if (released) fields.sectionId = previous?.sectionId ?? null;
  }
  const updated = engine.commit((out) => {
    const { projectId } = thread;
    if (changes.length > 0) out.thread(threadId, changes, { projectId });
    return store.patchThread(db, threadId, fields) ?? thread;
  });
  if (title != null && title !== thread.title) {
    engine.renameSession(updated, title);
  }
  return engine.respond(updated);
}

function patchAndAnnounce(
  engine: Engine,
  threadId: string,
  change: ThreadChangeKind,
  patch: store.ThreadPatch,
) {
  const { projectId } = engine.requireThread(threadId);
  const updated = engine.commit((out) => {
    out.thread(threadId, [change], { projectId });
    return store.patchThread(engine.ctx.db, threadId, patch);
  });
  return engine.respond(updated ?? engine.requireThread(threadId));
}

export function pin(engine: Engine, threadId: string) {
  const { db, now } = engine.ctx;
  const pinned = engine.requireThread(threadId).pinnedAt !== null;
  const pinning = { pinnedAt: now(), pinSortKey: store.nextPinSortKey(db) };
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
  store.reorderPinnedThread(db, threadId, previousThreadId, nextThreadId);
  hub.thread(threadId, ["pin-state-changed"], { projectId });
  return store.listPinnedThreadEntries(db, (thread, hostId) =>
    engine.displayState(thread, hostId),
  );
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

function queueChanged(engine: Engine, threadId: string): void {
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
    origin: null,
    originPluginId: null,
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
  if (row.systemNotice !== null) {
    throw conflict("System notices cannot be edited");
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

export function reorderQueuedMessage(
  engine: Engine,
  threadId: string,
  id: string,
  request: contract.ReorderQueuedMessageRequest,
) {
  engine.requireUnarchived(threadId);
  const previousId = request.previousQueuedMessageId;
  const nextId = request.nextQueuedMessageId;
  const boundaryId = request.groupBoundaryQueuedMessageId;
  const move = { threadId, id, previousId, nextId, boundaryId };
  const rows = queue.reorderQueuedMessage(engine.ctx.db, move);
  queueChanged(engine, threadId);
  return rows.map(queue.toThreadQueuedMessage);
}

export function setQueueGroupBoundary(
  engine: Engine,
  threadId: string,
  request: contract.SetQueuedMessageGroupBoundaryRequest,
) {
  engine.requireUnarchived(threadId);
  const rows = queue.setQueuedMessageGroupBoundary(
    engine.ctx.db,
    threadId,
    request.groupBoundaryQueuedMessageId,
    request.expectedGroupedPrefixQueuedMessageIds,
  );
  queueChanged(engine, threadId);
  return rows.map(queue.toThreadQueuedMessage);
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
