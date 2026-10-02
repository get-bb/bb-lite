import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptInput, ThreadEventRow } from "@bb/domain";
import type { CreateThreadEnvironmentArgs } from "@bb/server-contract";
import {
  confirm,
  durationMs,
  integer,
  loaded,
  machineFlag,
  machineOrThis,
  sendAtMs,
  textInput,
  threadTarget,
  validId,
  type Call,
} from "../call.js";
import { CliError, usageError, type Run } from "../engine.js";
import {
  pendingTodosOf,
  queueWait,
  threadLines,
  todoLines,
} from "../render.js";

type Action = "stop" | "archive" | "unarchive" | "compact" | "pin" | "unpin";
type Marker = "clearContext" | "markRead" | "markUnread";

const WORKSPACE_KINDS = ["worktree", "checkout", "personal"] as const;
const OPEN_SPLITS = ["right", "down", "left", "top", "replace"] as const;
const TIMELINE_TURN_LIMIT = 100;
const EVENT_PAGE_SIZE = 100;
const PERSONAL_PROJECT_ID = "proj_personal";

function execution(c: Call) {
  const { reasoningLevelValues, permissionModeValues } = loaded().domain;
  return {
    model: c.flag("model"),
    reasoningLevel: c.choice("reasoning-level", reasoningLevelValues),
    permissionMode: c.choice("permission-mode", permissionModeValues),
  };
}

function visibility(c: Call) {
  return c.choice("visibility", loaded().domain.threadVisibilityValues);
}

function clientPath(value: string): string | null {
  if (isAbsolute(value)) return value;
  return value.toLowerCase().startsWith("file:") ? fileURLToPath(value) : null;
}

async function promptInput(
  c: Call,
  text: string,
  projectId: () => Promise<string>,
): Promise<PromptInput[]> {
  const attach = async (
    type: "localFile" | "localImage",
    value: string,
  ): Promise<PromptInput> => {
    const local = clientPath(value);
    if (local === null) return { type, path: value };
    const uploaded = await c.sdk.projects.attachments.upload({
      projectId: await projectId(),
      clientFile: await readFile(local),
      filename: basename(local),
    });
    return { type, path: uploaded.path };
  };
  const files = c.list("file").map((path) => attach("localFile", path));
  const images = c.list("image").map((path) => attach("localImage", path));
  const attached = await Promise.all([...files, ...images]);
  return [{ type: "text", text, mentions: [] }, ...attached];
}

async function spawnEnvironment(
  c: Call,
  projectId: string,
): Promise<CreateThreadEnvironmentArgs> {
  const value = c.flag("environment")?.trim() || undefined;
  const kind = c.choice("new-environment", WORKSPACE_KINDS);
  const base = c.flag("base-branch")?.trim();
  if (value !== undefined && kind !== undefined) {
    throw usageError("Cannot combine --environment with --new-environment.");
  }
  if (base && kind !== "worktree") {
    throw usageError("--base-branch requires --new-environment worktree.");
  }
  const isPath = value !== undefined && /^[.~]|\//u.test(value);
  if (value !== undefined && !isPath) {
    if (!c.on("machine")) {
      return { type: "reuse", environmentId: validId(value, "--environment") };
    }
    throw usageError(
      "Cannot combine --machine with an environment ID; that environment " +
        "already selects its machine.",
    );
  }
  if (value === undefined && kind === undefined && !c.on("machine")) {
    return { type: "project-default" };
  }
  const hostId = await machineOrThis(c);
  if (kind === "worktree") {
    const baseBranch = base
      ? ({ kind: "named", name: base } as const)
      : ({ kind: "default" } as const);
    const workspace = { type: "managed-worktree", baseBranch } as const;
    return { type: "host", hostId, workspace };
  }
  const unspecified = value === undefined && kind === undefined;
  const personal = unspecified && projectId === PERSONAL_PROJECT_ID;
  if (kind === "personal" || personal) {
    return { type: "host", hostId, workspace: { type: "personal" } };
  }
  const workspace = { type: "unmanaged", path: value ?? null } as const;
  return { type: "host", hostId, workspace };
}

function spawnParent(c: Call): string | undefined {
  const explicit = c.id("parent-thread");
  if (!c.on("parent-self")) return explicit;
  if (explicit !== undefined) {
    throw usageError("Cannot combine --parent-thread with --parent-self.");
  }
  if (c.env.threadId !== undefined) return c.env.threadId;
  throw usageError("--parent-self requires BB_THREAD_ID to be set.");
}

export const threadSpawn: Run = async (c) => {
  const prompt = c.flag("prompt");
  const text = await textInput(c, prompt, "prompt-file", "--prompt <text>");
  const projectId = c.id("project");
  if (projectId === undefined) {
    const current = c.env.projectId ?? "<id> (see `bb project list`)";
    const detail = {
      code: "missing_required",
      hint: `Add --project ${current}.`,
    };
    throw new CliError("Missing required option --project <id>.", detail);
  }
  const parentThreadId = spawnParent(c);
  const scheduled = sendAtMs(c.flag("send-at"));
  const thread = await c.sdk.threads.spawn({
    origin: "cli",
    projectId,
    environment: await spawnEnvironment(c, projectId),
    input: await promptInput(c, text, async () => projectId),
    providerId: c.flag("provider")?.trim() || undefined,
    ...execution(c),
    title: c.flag("title") || undefined,
    visibility: visibility(c),
    parentThreadId,
    sectionId: c.id("section"),
    sendAt: scheduled,
  });
  const lines = [`Thread spawned: ${thread.id}`];
  if (scheduled !== undefined) {
    const when = new Date(scheduled).toLocaleString();
    lines.push(`First message scheduled for ${when}; pending until then.`);
  }
  if (parentThreadId !== undefined && parentThreadId === c.env.threadId) {
    lines.push("You will be notified when this thread is done.");
  }
  c.out(thread, [...lines, "", ...threadLines(thread, null), ""]);
};

export const threadTell: Run = async (c) => {
  const threadId = validId(c.arg("id"), "<id> argument");
  const { message } = c.args;
  const text = await textInput(c, message, "message-file", "<message>");
  const mode = c.choice("mode", ["steer", "queue", "auto"]) ?? "steer";
  const { sdk } = c;
  const project = async (): Promise<string> =>
    (await sdk.threads.get({ threadId })).projectId;
  const sender = c.env.threadId;
  const response = await sdk.threads.send({
    threadId,
    input: await promptInput(c, text, project),
    mode: mode === "auto" ? mode : `${mode}-if-active`,
    ...execution(c),
    senderThreadId: sender === threadId ? undefined : sender,
    sendAt: sendAtMs(c.flag("send-at")),
  });
  const outcome =
    response.delivery === "queued"
      ? `message queued (${queueWait(response.queuedMessage)}); it ` +
        "dispatches when that clears"
      : mode === "steer"
        ? "steered"
        : "updated";
  c.out({ threadId, ...response, mode }, `Thread ${threadId} ${outcome}`);
};

function waitRequest(c: Call) {
  const event = c.flag("event");
  if (event !== undefined && c.on("status")) {
    throw usageError("Provide only one of --status or --event.");
  }
  const { threadStatusValues } = loaded().domain;
  const status = c.choice("status", threadStatusValues) ?? "idle";
  const interval = c.flag("poll-interval") ?? "250ms";
  return {
    threadId: validId(c.arg("id"), "<id> argument"),
    ...(event === undefined ? { status } : { event }),
    timeoutMs: durationMs(c.flag("timeout") ?? "1200", "--timeout", "s", true),
    pollIntervalMs: durationMs(interval, "--poll-interval", "ms"),
  };
}

function waitFailure(error: Error, code: string, exitCode: number): never {
  throw new CliError(error.message, { code, exitCode });
}

export const threadWait: Run = async (c) => {
  let request: ReturnType<typeof waitRequest>;
  try {
    request = waitRequest(c);
  } catch (error) {
    if (error instanceof CliError) waitFailure(error, error.code, 3);
    throw error;
  }
  const { sdk } = c;
  const errors = loaded().sdk;
  const result = await sdk.threads.wait(request).catch((error: unknown) => {
    if (error instanceof errors.ThreadWaitTimeoutError) {
      waitFailure(error, "timeout", 2);
    }
    if (error instanceof errors.ThreadWaitUnreachableError) {
      waitFailure(error, "unreachable", 4);
    }
    throw error;
  });
  const { threadId, target } = result;
  const reached =
    "event" in result
      ? `observed event ${result.target.eventType} at seq ${result.event.seq}`
      : `reached status ${result.target.status}`;
  c.out({ threadId, matched: true, target }, `Thread ${threadId} ${reached}.`);
};

export const threadShow: Run = async (c) => {
  const threadId = threadTarget(c);
  const { sdk } = c;
  const thread = await sdk.threads.get({ threadId });
  const { environmentId } = thread;
  const environment = environmentId
    ? await sdk.environments.get({ environmentId }).catch(() => null)
    : null;
  const pendingTodos = await pendingTodosOf(sdk, threadId);
  const lines = threadLines(thread, environment);
  const data = { thread, environment, pendingTodos };
  c.out(data, [...lines, ...todoLines(pendingTodos)]);
};

async function logEvents(c: Call, threadId: string) {
  const wanted = c.on("all")
    ? Number.POSITIVE_INFINITY
    : (integer(c.flag("limit"), "--limit") ?? EVENT_PAGE_SIZE);
  const after = c.flag("after-seq");
  const rows: ThreadEventRow[] = [];
  const limit = String(EVENT_PAGE_SIZE);
  for (let afterSeq = after, more = true; more && rows.length <= wanted;) {
    const page = await c.sdk.threads.events.list({ threadId, limit, afterSeq });
    rows.push(...page);
    more = page.length === EVENT_PAGE_SIZE;
    afterSeq = String(page.at(-1)?.seq);
  }
  const shown = rows.slice(0, wanted);
  c.out(shown);
  if (rows.length > wanted) {
    const next = `--after-seq ${shown.at(-1)?.seq} for the next page, or --all`;
    console.error(`Showing ${shown.length} events; more exist. Use ${next}.`);
  }
}

export const threadLog: Run = async (c) => {
  const threadId = threadTarget(c);
  const chosen = c.choice("format", ["minimal", "verbose", "json"]);
  const format = c.json ? "json" : (chosen ?? "minimal");
  const all = c.on("all");
  const limit = all ? TIMELINE_TURN_LIMIT : integer(c.flag("limit"), "--limit");
  if (all && c.on("limit")) {
    throw usageError("--all cannot be combined with --limit.");
  }
  if (format !== "json" && c.on("after-seq")) {
    throw usageError("--after-seq is only supported with --format json.");
  }
  const { sdk } = c;
  if (format === "json") return logEvents(c, threadId);
  if (limit !== undefined && limit > TIMELINE_TURN_LIMIT) {
    const most = `--limit is at most ${TIMELINE_TURN_LIMIT} for the timeline`;
    throw usageError(`${most}; use --all for the whole thread.`);
  }
  const query = {
    threadId,
    ...(format === "verbose" ? { includeNestedRows: "true" as const } : {}),
    ...(limit === undefined ? {} : { segmentLimit: String(limit) }),
  };
  let { rows, timelinePage: page } = await sdk.threads.timeline(query);
  while (all && page.hasOlderRows && page.olderCursor !== null) {
    const older = await sdk.threads.timeline({
      ...query,
      beforeAnchorSeq: String(page.olderCursor.anchorSeq),
      beforeAnchorId: page.olderCursor.anchorId,
    });
    const known = new Set(rows.map((row) => row.id));
    rows = [...older.rows.filter((row) => !known.has(row.id)), ...rows];
    page = older.timelinePage;
  }
  const { formatThreadTimelineText } = await import("@bb/thread-view");
  const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
  const verbose = format === "verbose";
  const text = formatThreadTimelineText(rows, { verbose, color });
  const notice = page.hasOlderRows
    ? `\n\n(Showing the newest ${page.returnedSegmentCount} user-message ` +
      "turns; use --limit <n> (max 100) or --all for older history.)"
    : "";
  console.log(`${text}${notice}`);
};

export const threadOutput: Run = async (c) => {
  const threadId = threadTarget(c);
  const result = await c.sdk.threads.output({ threadId });
  c.out(result, result.output || "(no output)");
};

export const threadList: Run = async (c) => {
  if (c.on("section") && c.on("unsectioned")) {
    throw usageError("Cannot combine --section with --unsectioned.");
  }
  const { sdk } = c;
  const threads = await sdk.threads.list({
    projectId: c.id("project"),
    environmentId: c.id("environment"),
    hostId: await machineFlag(c),
    parentThreadId: c.id("parent-thread"),
    sectionId: c.id("section"),
    archived: c.on("archived") || undefined,
    unsectioned: c.on("unsectioned") || undefined,
    includeHidden: c.on("include-hidden") || undefined,
  });
  const count = threads.length;
  if (c.on("count")) return c.out({ count }, String(count));
  const rows = threads.map((thread) => ({
    ...thread,
    title: thread.title ?? thread.titleFallback,
    status: thread.archivedAt === null ? thread.status : "archived",
  }));
  c.rows(rows, ["id", "title", "projectId", "status"], threads);
};

export const threadUpdate: Run = async (c) => {
  const cleared = (set: string, clear: string): string | null | undefined => {
    if (c.on(set) && c.on(clear)) {
      throw usageError(`Cannot combine --${set} with --${clear}.`);
    }
    return c.on(clear) ? null : c.id(set);
  };
  const { reasoningLevelValues } = loaded().domain;
  const changes = {
    title: c.flag("title"),
    parentThreadId: cleared("parent-thread", "clear-parent-thread"),
    sectionId: cleared("section", "clear-section"),
    model: c.flag("model"),
    reasoningLevel: c.choice("reasoning-level", reasoningLevelValues),
    visibility: visibility(c),
  };
  const changed = Object.entries(changes).filter(
    ([, value]) => value !== undefined,
  );
  if (changed.length === 0) {
    const options = Object.keys(changes).join(", ");
    throw usageError("No changes requested.", `Change one of: ${options}.`);
  }
  const threadId = threadTarget(c);
  const thread = await c.sdk.threads.update({ threadId, ...changes });
  const lines = changed.map(([key, value]) => `  ${key}: ${value ?? "none"}`);
  c.out(thread, [`Thread ${thread.id} updated`, ...lines]);
};

function action(method: Action | Marker, done: string): Run {
  return async (c) => {
    const threadId = threadTarget(c);
    const result = await c.sdk.threads[method]({ threadId });
    const data = "ok" in result ? { ...result, threadId } : result;
    c.out(data, `Thread ${threadId} ${done}`);
  };
}

export const threadStop = action("stop", "stopped");
export const threadArchive = action("archive", "archived");
export const threadUnarchive = action("unarchive", "unarchived");
export const threadCompact = action("compact", "compaction requested");
export const threadClear = action("clearContext", "context cleared");
export const threadPin = action("pin", "pinned");
export const threadUnpin = action("unpin", "unpinned");
export const threadRead = action("markRead", "marked read");
export const threadUnread = action("markUnread", "marked unread");

export const threadDelete: Run = async (c) => {
  const threadId = validId(c.arg("id"), "<id> argument");
  await confirm(c, `Delete thread ${threadId} permanently?`);
  const childThreadsConfirmed = c.on("confirm-child-threads");
  await c.sdk.threads.delete({ threadId, childThreadsConfirmed });
  c.out({ ok: true, threadId }, `Thread ${threadId} deleted`);
};

export const threadSearch: Run = async (c) => {
  const limit = integer(c.flag("limit"), "--limit");
  const limitPerGroup = limit === undefined ? undefined : String(limit);
  const query = c.arg("query");
  c.out(await c.sdk.threads.search({ query, limitPerGroup }));
};

function inside(root: string | null | undefined, target: string) {
  if (root == null) return null;
  const path = relative(resolve(root), resolve(target));
  const outside = path === "" || path.startsWith("..") || isAbsolute(path);
  return outside ? null : path.split(sep).join("/");
}

async function openFile(c: Call, threadId: string, path: string) {
  if (!isAbsolute(path)) return { source: "workspace", path } as const;
  const own = c.env.threadId === threadId;
  const stored = inside(own ? c.env.threadStorage : null, path);
  if (stored !== null)
    return { source: "thread-storage", path: stored } as const;
  const { sdk } = c;
  const { environmentId } = await sdk.threads.get({ threadId });
  const environment =
    environmentId === null
      ? null
      : await sdk.environments.get({ environmentId });
  const local = inside(environment?.path, path);
  if (local !== null) return { source: "workspace", path: local } as const;
  const roots = "the thread's workspace or BB_THREAD_STORAGE";
  throw usageError(`An absolute path must be inside ${roots}.`);
}

export const threadOpen: Run = async (c) => {
  const { id: first, path: second } = c.args;
  const current = c.env.threadId;
  const named =
    first !== undefined &&
    (second !== undefined || current === undefined || first.startsWith("thr_"));
  const threadId = named ? validId(first, "<id> argument") : current;
  if (threadId === undefined) {
    throw usageError("Missing thread ID. Pass [id] or run inside a thread.");
  }
  const path = named ? second : first;
  const lineNumber = integer(c.flag("line"), "--line") ?? null;
  if (path === undefined && lineNumber !== null) {
    throw usageError("--line requires a file path.");
  }
  const split = c.choice("split", OPEN_SPLITS);
  const file =
    path === undefined
      ? null
      : { ...(await openFile(c, threadId, path)), lineNumber };
  const { delivered } = await c.sdk.threads.open({ threadId, split, file });
  const shown = file === null ? "" : ` with ${file.path}`;
  const text = `Opened thread ${threadId}${shown} in ${delivered} window(s)`;
  c.out({ threadId, split: split ?? "replace", file, delivered }, text);
};
