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
import type { ThreadRow } from "@bb/server-kit/db/threads";
import { ApiError } from "@bb/server-kit/http/errors";
import type { Realtime } from "@bb/plugin";

export interface ThreadRuntime {
  provisioning: { id: string; abort: AbortController } | null;
  pendingStart: string | null;
  cancelledStart: string | null;
}

export class Outbox {
  private readonly actions: (() => void)[] = [];

  constructor(private readonly hub: Realtime) {}

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

  flush(report: (error: unknown) => void): void {
    for (const action of this.actions) {
      try {
        action();
      } catch (error) {
        report(error);
      }
    }
  }
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
