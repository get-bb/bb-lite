import type {
  Environment,
  QueuedMessageWaitingOn,
  ThreadTimelinePendingTodos,
} from "@bb/domain";
import type { BbSdk } from "@bb/sdk";
import type { ThreadResponse } from "@bb/server-contract";

interface QueueWait {
  sendAt: number | null;
  waitingOn: QueuedMessageWaitingOn | null;
}

const TODO_MARKS = { in_progress: "[>]", pending: "[ ]", completed: "[x]" };

function date(at: number): string {
  return new Date(at).toLocaleString();
}

export async function pendingTodosOf(
  sdk: BbSdk,
  threadId: string,
): Promise<ThreadTimelinePendingTodos | null> {
  const summaryOnly = "true";
  const request = sdk.threads.timeline({ threadId, summaryOnly });
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
  switch (waitingOn.kind) {
    case "time":
      return row.sendAt === null
        ? "scheduled"
        : `scheduled for ${date(row.sendAt)}`;
    case "thread-busy":
      return "waiting for the current turn to finish";
    case "stopping":
      return "sending once the thread finishes stopping";
    case "turn-starting":
      return "waiting for the current turn to start";
    case "provisioning":
      return "waiting for the workspace";
    case "host-offline":
      return `waiting for ${waitingOn.hostName} to reconnect`;
    case "interaction":
      return "waiting for a pending interaction";
    case "plugin":
      return `${waitingOn.pluginId}: ${waitingOn.reason}`;
  }
}
