import type { Remote } from "./call.js";
import type {
  Environment,
  QueuedMessageWaitingOn,
  ThreadTimelinePendingTodos,
} from "@bb/domain";
import type { ThreadResponse } from "@bb/server-contract";

interface QueueWait {
  sendAt: number | null;
  waitingOn: QueuedMessageWaitingOn | null;
}

const TODO_MARKS = { in_progress: "[>]", pending: "[ ]", completed: "[x]" };
const WAITS = {
  "thread-busy": "waiting for the current turn to finish",
  stopping: "sending once the thread finishes stopping",
  "turn-starting": "waiting for the current turn to start",
  provisioning: "waiting for the workspace",
  interaction: "waiting for a pending interaction",
};

function date(at: number): string {
  return new Date(at).toLocaleString();
}

export async function pendingTodosOf(
  remote: Remote,
  threadId: string,
): Promise<ThreadTimelinePendingTodos | null> {
  const summary = { threadId, summaryOnly: true };
  const request = remote.op(remote.ops.threads.timeline, summary);
  return (await request.catch(() => null))?.pendingTodos ?? null;
}

export function todoLines(todos: ThreadTimelinePendingTodos | null): string[] {
  if (todos === null || todos.items.length === 0) return [];
  const done = todos.items.filter((item) => item.status === "completed");
  const items = todos.items.map(
    (item) => `  ${TODO_MARKS[item.status]} ${item.text}`,
  );
  return ["", `TODOs (${done.length}/${todos.items.length} done):`, ...items];
}

export function threadLines(
  thread: ThreadResponse,
  environment: Environment | null,
): string[] {
  const place =
    environment === null
      ? thread.environmentId
      : `${environment.id} on ${environment.hostId} ` +
        `(${environment.path ?? "no path"})`;
  return [
    `Thread: ${thread.id}`,
    `  Status: ${thread.status}`,
    thread.title ? `  Title: ${thread.title}` : "",
    `  Project: ${thread.projectId}`,
    thread.parentThreadId ? `  Parent: ${thread.parentThreadId}` : "",
    thread.archivedAt === null ? "" : `  Archived: ${date(thread.archivedAt)}`,
    thread.pinnedAt === null ? "" : `  Pinned: ${date(thread.pinnedAt)}`,
    place ? `  Environment: ${place}` : "",
    `  Created: ${date(thread.createdAt)}`,
    `  Updated: ${date(thread.updatedAt)}`,
  ].filter(Boolean);
}

export function queueWait(row: QueueWait): string {
  const waitingOn = row.waitingOn ?? { kind: "thread-busy" };
  if (waitingOn.kind === "time") {
    return row.sendAt === null ? "scheduled" : `due ${date(row.sendAt)}`;
  }
  if (waitingOn.kind === "host-offline") {
    return `waiting for ${waitingOn.hostName} to reconnect`;
  }
  if (waitingOn.kind === "plugin") {
    return `${waitingOn.pluginId}: ${waitingOn.reason}`;
  }
  return WAITS[waitingOn.kind];
}
