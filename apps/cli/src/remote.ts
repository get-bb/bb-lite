import type { ThreadEventRow, ThreadStatus } from "@bb/domain";
import type {
  ThreadResponse,
  UploadedPromptAttachment,
} from "@bb/server-contract";
import type { Remote } from "./call.js";

const MAX_EVENT_WAIT_MS = 30_000;

export type ThreadWaitTarget =
  | { kind: "status"; status: ThreadStatus }
  | { kind: "event"; eventType: string };

export interface ThreadWaitRequest {
  threadId: string;
  status?: ThreadStatus;
  event?: string;
  timeoutMs: number;
  pollIntervalMs: number;
}

export type ThreadWaitResult = { matched: true; threadId: string } & (
  | {
      event: ThreadEventRow;
      target: Extract<ThreadWaitTarget, { kind: "event" }>;
    }
  | {
      thread: ThreadResponse;
      target: Extract<ThreadWaitTarget, { kind: "status" }>;
    }
);

export class ThreadWaitTimeoutError extends Error {
  constructor(threadId: string, target: ThreadWaitTarget) {
    super(
      target.kind === "status"
        ? `Timed out waiting for thread ${threadId} to reach status ${target.status}.`
        : `Timed out waiting for thread ${threadId} event ${target.eventType}.`,
    );
    this.name = "ThreadWaitTimeoutError";
  }
}

export class ThreadWaitUnreachableError extends Error {
  constructor(threadId: string, status: ThreadStatus) {
    super(
      `Thread ${threadId} is in status ${status} and will not reach idle by waiting alone. ` +
        `Inspect it with 'bb thread show ${threadId}' and recover with 'bb thread retry ${threadId}' or a follow-up.`,
    );
    this.name = "ThreadWaitUnreachableError";
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitForThread(
  remote: Remote,
  request: ThreadWaitRequest,
): Promise<ThreadWaitResult> {
  const { threadId, pollIntervalMs } = request;
  const { threads } = remote.ops;
  const deadline = Date.now() + request.timeoutMs;
  const target: ThreadWaitTarget =
    request.event === undefined
      ? { kind: "status", status: request.status ?? "idle" }
      : { kind: "event", eventType: request.event };
  for (;;) {
    if (target.kind === "status") {
      const thread = await remote.op(threads.get, { threadId });
      if (thread.status === target.status) {
        return { matched: true, target, thread, threadId };
      }
      if (target.status === "idle" && thread.status === "error") {
        throw new ThreadWaitUnreachableError(threadId, thread.status);
      }
    } else {
      const remaining = Math.max(0, deadline - Date.now());
      const waitMs = Math.floor(Math.min(remaining, MAX_EVENT_WAIT_MS));
      const type = target.eventType;
      const event = await remote.op(threads.nextEvent, {
        threadId,
        type,
        waitMs,
      });
      if (event !== null) return { event, matched: true, target, threadId };
    }
    if (Date.now() >= deadline) {
      throw new ThreadWaitTimeoutError(threadId, target);
    }
    await sleep(pollIntervalMs);
  }
}

export async function uploadAttachment(
  remote: Remote,
  upload: { projectId: string; bytes: Uint8Array; filename: string },
): Promise<UploadedPromptAttachment> {
  const { projectId, bytes, filename } = upload;
  if (filename.trim() === "") {
    throw new Error("Project attachment filename must not be empty");
  }
  const body = new FormData();
  body.set("file", new Blob([new Uint8Array(bytes)]), filename);
  const path = `/api/v1/projects/${encodeURIComponent(projectId)}/attachments`;
  const response = await remote.request(path, { method: "POST", body });
  return (await response.json()) as UploadedPromptAttachment;
}
