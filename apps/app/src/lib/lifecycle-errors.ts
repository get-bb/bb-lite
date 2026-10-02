import { BbHttpError } from "@bb/sdk/browser";
import {
  lifecycleApiErrorSchema,
  type LifecycleApiError,
} from "@bb/server-contract";

type Severity = "info" | "warning" | "error";

export interface LifecycleErrorDescription {
  body: string;
  severity: Severity;
  title: string;
}

const OPERATION_TITLES = {
  archive_thread: "Failed to archive thread",
  commit: "Commit failed",
  create_thread: "Failed to create thread",
  load_git_status: "Workspace status unavailable",
  load_thread_storage: "Failed to load thread storage",
  open_terminal: "Failed to open terminal",
  queue_message: "Failed to queue message",
  resolve_interaction: "Failed to submit response",
  send_message: "Failed to send message",
  send_queued_message: "Failed to send queued message",
  stop_thread: "Failed to stop thread",
  update_queued_message: "Failed to update queued message",
  update_merge_base: "Failed to update merge base",
} as const;

export type LifecycleErrorOperation = keyof typeof OPERATION_TITLES;

type Entry = readonly [severity: Severity, title: string, body: string];

const STARTING: Entry = [
  "info",
  "Workspace starting",
  "Workspace is still starting.",
];
const GONE: Entry = [
  "warning",
  "Workspace unavailable",
  "Workspace no longer exists.",
];
const SETUP_FAILED: Entry = [
  "error",
  "Workspace setup failed",
  "Workspace setup failed.",
];

const ENVIRONMENT_STATUS: Record<string, Entry> = {
  creating: STARTING,
  provisioning: STARTING,
  ready: ["warning", "Workspace unavailable", "Workspace is unavailable."],
  error: SETUP_FAILED,
  destroyed: GONE,
};

const THREAD_ENVIRONMENT: Record<string, Entry> = {
  never_attached: [
    "info",
    "Workspace unavailable",
    "Workspace is not available yet.",
  ],
  destroyed: GONE,
  provisioning: STARTING,
  errored: SETUP_FAILED,
};

const THREAD_NOT_WRITABLE: Record<string, Entry> = {
  archived: ["info", "Thread archived", "Unarchive the thread first."],
  deleted: ["error", "Thread deleted", "This thread was deleted."],
  errored: [
    "error",
    "Thread failed",
    "This thread failed and cannot continue.",
  ],
  already_active: [
    "warning",
    "Thread already running",
    "The thread is already running.",
  ],
};

const PARENT_THREAD: Record<string, string> = {
  not_found: "That parent thread no longer exists.",
  archived: "Unarchive the parent thread first or choose another parent.",
  deleted: "That parent thread was deleted.",
  self: "A thread cannot be its own parent.",
  cycle: "Choose a thread that is not a child of this thread.",
  too_deep: "Thread nesting is limited to 4 levels.",
};

const SENDER_THREAD: Record<string, string> = {
  not_found: "The sender thread no longer exists.",
  archived: "The sender thread is archived.",
  deleted: "The sender thread was deleted.",
};

function entryFor(error: LifecycleApiError): Entry | undefined {
  switch (error.code) {
    case "environment_not_ready":
      return ENVIRONMENT_STATUS[error.details.environmentStatus];
    case "thread_environment_unavailable":
      return THREAD_ENVIRONMENT[error.details.reason];
    case "thread_not_writable":
      return THREAD_NOT_WRITABLE[error.details.reason];
    case "host_unavailable":
      return ["warning", "Host offline", "Host is offline."];
    case "parent_thread_invalid": {
      const { reason, subject } = error.details;
      const sender = subject === "sender";
      const body = (sender ? SENDER_THREAD : PARENT_THREAD)[reason];
      const title = `${sender ? "Sender" : "Parent"} thread unavailable`;
      const severity = reason === "archived" ? "warning" : "error";
      return body === undefined ? undefined : [severity, title, body];
    }
    default:
      return undefined;
  }
}

export function parseLifecycleError(error: unknown): LifecycleApiError | null {
  if (!(error instanceof BbHttpError)) return null;
  const result = lifecycleApiErrorSchema.safeParse(error.body);
  return result.success ? result.data : null;
}

export function isHostDisconnectedError(error: unknown): boolean {
  return parseLifecycleError(error)?.code === "host_unavailable";
}

export function formatLifecycleErrorDescription(
  description: LifecycleErrorDescription,
): string {
  return `${description.title}. ${description.body}`;
}

export function describeLifecycleError({
  error,
  operation,
}: {
  error: unknown;
  operation?: LifecycleErrorOperation | undefined;
}): LifecycleErrorDescription | null {
  const lifecycleError = parseLifecycleError(error);
  const entry = lifecycleError ? entryFor(lifecycleError) : undefined;
  if (entry === undefined) return null;
  const [severity, title, body] = entry;
  return {
    title: operation ? OPERATION_TITLES[operation] : title,
    body,
    severity,
  };
}

export function isLifecycleErrorOperation(
  value: unknown,
): value is LifecycleErrorOperation {
  return typeof value === "string" && value in OPERATION_TITLES;
}
