import type {
  ProjectChangeKind,
  ThreadChangeKind,
  ThreadChangeMetadata,
} from "@bb/domain";
import type {
  ThreadEnvironmentUnavailableErrorDetails,
  ThreadNotWritableErrorDetails,
  ThreadNotWritableReason,
} from "@bb/server-contract";
import type { ServerContext } from "../context.js";
import type { ThreadRow } from "../db/threads.js";
import { ApiError } from "../http/errors.js";
import type { Hub } from "../ws/hub.js";

export type EngineContext = Omit<ServerContext, "threads">;

export interface ThreadRuntime {
  provisioning: { id: string; abort: AbortController } | null;
  pendingStart: string | null;
  cancelledStart: string | null;
}

export class Outbox {
  private readonly actions: (() => void)[] = [];

  constructor(private readonly hub: Hub) {}

  thread(
    id: string,
    changes: ThreadChangeKind[],
    metadata?: ThreadChangeMetadata,
  ): void {
    this.actions.push(() => this.hub.thread(id, changes, metadata));
  }

  project(id: string, changes: ProjectChangeKind[]): void {
    this.actions.push(() => this.hub.project(id, changes));
  }

  after(action: () => void): void {
    this.actions.push(action);
  }

  flush(): void {
    for (const action of this.actions) action();
  }
}

export class ThreadSerial {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(threadId: string, work: () => T | Promise<T>): Promise<T> {
    const result = (this.tails.get(threadId) ?? Promise.resolve()).then(work);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.tails.set(threadId, tail);
    void tail.then(() => {
      if (this.tails.get(threadId) === tail) this.tails.delete(threadId);
    });
    return result;
  }

  async idle(): Promise<void> {
    while (this.tails.size > 0) await Promise.all(this.tails.values());
  }
}

export function threadNotFound(): ApiError {
  return new ApiError(404, "thread_not_found", "Thread not found");
}

export function notWritable(
  thread: ThreadRow,
  reason: ThreadNotWritableReason,
  message: string,
): ApiError {
  const details: ThreadNotWritableErrorDetails = {
    reason,
    archivedAt: thread.archivedAt,
    threadStatus: thread.status,
  };
  return new ApiError(409, "thread_not_writable", message, { details });
}

export function environmentUnavailable(
  details: ThreadEnvironmentUnavailableErrorDetails,
): ApiError {
  const message = "Thread environment is not available";
  return new ApiError(409, "thread_environment_unavailable", message, {
    details,
  });
}

export function conflict(message: string): ApiError {
  return new ApiError(409, "invalid_request", message);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
