import { parseThreadEventRow, validatePluginMetadata } from "@bb/domain";
import type * as domain from "@bb/domain";
import { publicApiRoutes, threadTabsResponseSchema } from "@bb/server-contract";
import type * as api from "@bb/server-contract";
import { count, flag, pick, type Http } from "../http.js";

const DEFAULT_THREAD_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS = 250;
const MAX_EVENT_WAIT_MS = 30_000;

type Ok = { ok: true };
type Acknowledged =
  | "stop"
  | "compact"
  | "clearContext"
  | "cancelPlan"
  | "unarchive";
type Abortable = { signal?: AbortSignal };

export interface ThreadTarget extends Abortable {
  threadId: string;
}

interface QueuedMessageTarget {
  queuedMessageId: string;
  threadId: string;
}

interface InteractionTarget {
  interactionId: string;
  threadId: string;
}

export interface ThreadListArgs extends Abortable {
  archived?: boolean;
  environmentId?: string;
  hostId?: string;
  sectionId?: string;
  hasParent?: boolean;
  includeHidden?: boolean;
  limit?: number;
  offset?: number;
  originKind?: api.ThreadListQuery["originKind"];
  originPluginId?: string;
  parentThreadId?: string;
  projectId?: string;
  unsectioned?: boolean;
}

export type ThreadGetResult =
  | api.ThreadResponse
  | api.ThreadWithIncludesResponse;
export type ThreadMutationResult = api.ThreadResponse;

type SpawnRequest = api.CreateThreadRequest;
export type ThreadSpawnArgs = Omit<
  SpawnRequest,
  "input" | "origin" | "startedOnBehalfOf"
> &
  Partial<Pick<SpawnRequest, "origin" | "startedOnBehalfOf">> &
  (
    | { input: SpawnRequest["input"]; prompt?: never }
    | { input?: never; prompt: string }
  );

export interface ThreadUpdateArgs extends api.UpdateThreadRequest {
  threadId: string;
}

export interface ThreadEventsListArgs extends ThreadTarget {
  afterSeq?: string;
  beforeSeq?: string;
  limit?: string;
  order?: "asc" | "desc";
  types?: readonly [domain.ThreadEventType, ...domain.ThreadEventType[]];
}

export interface ThreadEventWaitArgs extends ThreadTarget {
  afterSeq?: string;
  type: string;
  waitMs: string;
}

export type ThreadWaitTarget =
  | { kind: "status"; status: domain.ThreadStatus }
  | { kind: "event"; eventType: string };
type StatusWaitTarget = Extract<ThreadWaitTarget, { kind: "status" }>;

export interface ThreadWaitArgs extends ThreadTarget {
  event?: string;
  pollIntervalMs?: number;
  status?: domain.ThreadStatus;
  timeoutMs?: number;
}

export type ThreadWaitResult = { matched: true; threadId: string } & (
  | {
      event: domain.ThreadEventRow;
      target: Extract<ThreadWaitTarget, { kind: "event" }>;
    }
  | { target: StatusWaitTarget; thread: ThreadGetResult }
);

export class ThreadWaitTimeoutError extends Error {
  readonly target: ThreadWaitTarget;
  readonly threadId: string;

  constructor(args: { target: ThreadWaitTarget; threadId: string }) {
    const { target, threadId } = args;
    super(
      target.kind === "status"
        ? `Timed out waiting for thread ${threadId} to reach status ${target.status}.`
        : `Timed out waiting for thread ${threadId} event ${target.eventType}.`,
    );
    this.name = "ThreadWaitTimeoutError";
    this.target = target;
    this.threadId = threadId;
  }
}

export class ThreadWaitUnreachableError extends Error {
  readonly currentStatus: domain.ThreadStatus;
  readonly target: StatusWaitTarget;
  readonly threadId: string;

  constructor(args: {
    currentStatus: domain.ThreadStatus;
    target: StatusWaitTarget;
    threadId: string;
  }) {
    super(
      `Thread ${args.threadId} is in status ${args.currentStatus} and will not reach idle by waiting alone. ` +
        `Inspect it with 'bb thread show ${args.threadId}' and recover by sending a follow-up.`,
    );
    this.name = "ThreadWaitUnreachableError";
    this.currentStatus = args.currentStatus;
    this.target = args.target;
    this.threadId = args.threadId;
  }
}

export interface ThreadsArea {
  archive(args: ThreadTarget): Promise<api.ThreadArchiveAllResponse>;
  archiveAll(args: ThreadTarget): Promise<api.ThreadArchiveAllResponse>;
  childSummary(args: ThreadTarget): Promise<api.ThreadChildSummaryResponse>;
  compact(args: ThreadTarget): Promise<Ok>;
  cancelPlan(args: ThreadTarget): Promise<Ok>;
  clearContext(args: ThreadTarget): Promise<Ok>;
  defaultExecutionOptions(
    args: ThreadTarget,
  ): Promise<domain.ResolvedThreadExecutionOptions | null>;
  delete(args: api.DeleteThreadRequest & { threadId: string }): Promise<Ok>;
  events: {
    list(args: ThreadEventsListArgs): Promise<domain.ThreadEventRow[]>;
  };
  get(
    args: ThreadTarget & { include?: api.ThreadGetQuery["include"] },
  ): Promise<ThreadGetResult>;
  queue: {
    list(
      args?: Abortable & {
        threadId?: string;
        waitHolder?: domain.QueuedMessageWaitHolder;
      },
    ): Promise<api.ThreadQueuedMessageListResponse>;
  };
  interactions: {
    cancel(args: InteractionTarget): Promise<domain.PendingInteraction>;
    get(
      args: InteractionTarget & Abortable,
    ): Promise<domain.PendingInteraction>;
    list(args: ThreadTarget): Promise<api.ThreadPendingInteractionsResponse>;
    resolve(
      args: InteractionTarget & {
        resolution: domain.PendingInteractionResolution;
      },
    ): Promise<domain.PendingInteraction>;
    respond(
      args: InteractionTarget & { value: domain.JsonValue },
    ): Promise<domain.PendingInteraction>;
  };
  list(args?: ThreadListArgs): Promise<api.ThreadListResponse>;
  markRead(args: ThreadTarget): Promise<api.ThreadResponse>;
  markUnread(args: ThreadTarget): Promise<api.ThreadResponse>;
  open(args: {
    threadId: string;
    split?: api.ThreadOpenSplit;
    file: api.ThreadOpenFile | null;
  }): Promise<api.ThreadOpenResponse>;
  output(args: ThreadTarget): Promise<{ output: string | null }>;
  pin(args: ThreadTarget): Promise<ThreadMutationResult>;
  promptHistory(
    args: ThreadTarget & api.PromptHistoryQuery,
  ): Promise<api.PromptHistoryResponse>;
  queuedMessages: {
    create(
      args: api.CreateQueuedMessageRequest & { threadId: string },
    ): Promise<domain.ThreadQueuedMessage>;
    delete(args: QueuedMessageTarget): Promise<Ok>;
    list(args: ThreadTarget): Promise<api.ThreadQueuedMessageListResponse>;
    send(
      args: QueuedMessageTarget & api.SendQueuedMessageRequest,
    ): Promise<api.SendQueuedMessageResponse>;
    update(
      args: QueuedMessageTarget & api.UpdateQueuedMessageRequest,
    ): Promise<domain.ThreadQueuedMessage>;
  };
  reorderPinned(
    args: api.ReorderPinnedThreadRequest & { threadId: string },
  ): Promise<api.ThreadListResponse>;
  resolveMentions(
    args: api.ResolveThreadMentionsRequest & Abortable,
  ): Promise<api.ResolveThreadMentionsResponse>;
  restoreEnvironment(args: ThreadTarget): Promise<api.ThreadResponse>;
  search(
    args: api.ThreadSearchQuery & Abortable,
  ): Promise<api.ThreadSearchResponse>;
  send(
    args: api.SendMessageRequest & { threadId: string },
  ): Promise<api.SendMessageResponse>;
  spawn(args: ThreadSpawnArgs): Promise<api.ThreadResponse>;
  stop(args: ThreadTarget): Promise<Ok>;
  tabs: {
    get(args: ThreadTarget): Promise<api.ThreadTabsResponse>;
    update(
      args: api.UpdateThreadTabsRequest & { threadId: string },
    ): Promise<api.ThreadTabsResponse>;
  };
  timeline(
    args: ThreadTarget & api.ThreadTimelineQuery,
  ): Promise<api.ThreadTimelineResponse>;
  timelineTurnSummaryDetails(
    args: ThreadTarget & api.TimelineTurnSummaryDetailsQuery,
  ): Promise<api.TimelineTurnSummaryDetailsResponse>;
  storagePaths(
    args: ThreadTarget & api.ThreadStoragePathsQuery,
  ): Promise<api.ThreadStoragePathListResponse>;
  unarchive(args: ThreadTarget): Promise<Ok>;
  unpin(args: ThreadTarget): Promise<ThreadMutationResult>;
  update(args: ThreadUpdateArgs): Promise<ThreadMutationResult>;
  wait(args: ThreadWaitArgs): Promise<ThreadWaitResult>;
}

function listQuery(args: ThreadListArgs = {}): api.ThreadListQuery {
  return {
    projectId: args.projectId || undefined,
    environmentId: args.environmentId || undefined,
    hostId: args.hostId || undefined,
    parentThreadId: args.parentThreadId || undefined,
    sectionId: args.sectionId || undefined,
    originKind: args.originKind || undefined,
    originPluginId: args.originPluginId || undefined,
    archived: flag(args.archived),
    unsectioned: flag(args.unsectioned),
    includeHidden: flag(args.includeHidden),
    limit: count(args.limit),
    offset: count(args.offset),
    hasParent: flag(args.hasParent),
  };
}

function spawnJson(args: ThreadSpawnArgs): api.CreateThreadRequest {
  const { input, origin, prompt, startedOnBehalfOf, ...request } = args;
  if (input !== undefined && prompt !== undefined) {
    throw new Error("Provide only one of input or prompt.");
  }
  const { pluginMetadata } = args;
  return {
    ...request,
    ...(pluginMetadata === undefined
      ? {}
      : { pluginMetadata: validatePluginMetadata(pluginMetadata) }),
    input: input ?? [{ type: "text", text: prompt ?? "", mentions: [] }],
    origin: origin ?? "sdk",
    startedOnBehalfOf: startedOnBehalfOf ?? null,
  };
}

function waitPlan(args: ThreadWaitArgs) {
  const timeoutMs = args.timeoutMs ?? DEFAULT_THREAD_WAIT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(
      "Timeout must be a non-negative number of milliseconds.",
    );
  }
  const pollIntervalMs =
    args.pollIntervalMs ?? DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new RangeError(
      "Poll interval must be a positive integer number of milliseconds.",
    );
  }
  if (args.status !== undefined && args.event !== undefined) {
    throw new Error("Provide only one of status or event.");
  }
  const target: ThreadWaitTarget =
    args.event === undefined
      ? { kind: "status", status: args.status ?? "idle" }
      : { kind: "event", eventType: args.event };
  return { pollIntervalMs, target, deadline: Date.now() + timeoutMs };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createThreadsArea(http: Http): ThreadsArea {
  const routes = publicApiRoutes.threads;
  const at = (threadId: string) => ({ param: { id: threadId } });
  const queued = ({ threadId, queuedMessageId }: QueuedMessageTarget) => ({
    param: { id: threadId, queuedMessageId },
  });
  const interaction = ({ threadId, interactionId }: InteractionTarget) => ({
    param: { id: threadId, interactionId },
  });
  const acknowledged =
    (route: (typeof routes)[Acknowledged]) =>
    async ({ threadId }: ThreadTarget): Promise<Ok> => {
      await http.send(route, at(threadId));
      return { ok: true };
    };

  const get: ThreadsArea["get"] = ({ threadId, include, signal }) =>
    http.json(
      routes.get,
      {
        ...at(threadId),
        ...(include === undefined ? {} : { query: { include } }),
      },
      signal,
    );
  const archiveAll: ThreadsArea["archiveAll"] = ({ threadId }) =>
    http.json(routes.archiveAll, at(threadId));

  async function waitForEvent(args: ThreadEventWaitArgs) {
    const { threadId, signal } = args;
    const query = pick(args, ["afterSeq", "type", "waitMs"]);
    const input = { ...at(threadId), query };
    const reply = await http.send(routes.eventWait, input, signal);
    if (reply.status === 204) return null;
    return parseThreadEventRow(await reply.json());
  }

  async function wait(args: ThreadWaitArgs): Promise<ThreadWaitResult> {
    const { pollIntervalMs, target, deadline } = waitPlan(args);
    const { threadId, signal } = args;
    for (;;) {
      if (target.kind === "status") {
        const thread = await get({ signal, threadId });
        if (thread.status === target.status) {
          return { matched: true, target, thread, threadId };
        }
        if (target.status === "idle" && thread.status === "error") {
          const currentStatus = thread.status;
          throw new ThreadWaitUnreachableError({
            currentStatus,
            target,
            threadId,
          });
        }
      } else {
        const remainingMs = Math.max(0, deadline - Date.now());
        const waitMs = Math.floor(Math.min(remainingMs, MAX_EVENT_WAIT_MS));
        const type = target.eventType;
        const waiting = { signal, threadId, type, waitMs: String(waitMs) };
        const event = await waitForEvent(waiting);
        if (event !== null) return { event, matched: true, target, threadId };
      }
      if (Date.now() >= deadline) {
        throw new ThreadWaitTimeoutError({ target, threadId });
      }
      await sleep(pollIntervalMs);
    }
  }

  return {
    archive: archiveAll,
    archiveAll,
    childSummary: ({ threadId, signal }) =>
      http.json(routes.childSummary, at(threadId), signal),
    compact: acknowledged(routes.compact),
    cancelPlan: acknowledged(routes.cancelPlan),
    clearContext: acknowledged(routes.clearContext),
    defaultExecutionOptions: ({ threadId, signal }) =>
      http.json(routes.defaultExecutionOptions, at(threadId), signal),
    async delete({ threadId, childThreadsConfirmed }) {
      const json = { childThreadsConfirmed };
      await http.send(routes.delete, { ...at(threadId), json });
      return { ok: true };
    },
    events: {
      list({ threadId, signal, types, ...page }) {
        const query = {
          ...pick(page, ["afterSeq", "beforeSeq", "limit", "order"]),
          types: types?.join(","),
        };
        return http.json(routes.events, { ...at(threadId), query }, signal);
      },
    },
    get,
    queue: {
      list: (args = {}) =>
        http.json(
          publicApiRoutes.queue.list,
          { query: pick(args, ["threadId", "waitHolder"]) },
          args.signal,
        ),
    },
    interactions: {
      cancel: (args) => http.json(routes.cancelInteraction, interaction(args)),
      get: (args) =>
        http.json(routes.interaction, interaction(args), args.signal),
      list: ({ threadId, signal }) =>
        http.json(routes.interactions, at(threadId), signal),
      resolve: (args) =>
        http.json(routes.resolveInteraction, {
          ...interaction(args),
          json: args.resolution,
        }),
      respond: (args) =>
        http.json(routes.respondToInteraction, {
          ...interaction(args),
          json: { value: args.value },
        }),
    },
    list: (args) =>
      http.json(routes.list, { query: listQuery(args) }, args?.signal),
    markRead: ({ threadId, signal }) =>
      http.json(routes.read, at(threadId), signal),
    markUnread: ({ threadId, signal }) =>
      http.json(routes.unread, at(threadId), signal),
    open({ threadId, split, file }) {
      const json = { ...(split === undefined ? {} : { split }), file };
      return http.json(routes.open, { ...at(threadId), json });
    },
    output: ({ threadId, signal }) =>
      http.json(routes.output, at(threadId), signal),
    pin: ({ threadId }) => http.json(routes.pin, at(threadId)),
    promptHistory: ({ threadId, limit, signal }) =>
      http.json(
        routes.promptHistory,
        { ...at(threadId), query: { limit } },
        signal,
      ),
    queuedMessages: {
      create: ({ threadId, ...json }) =>
        http.json(routes.createQueuedMessage, { ...at(threadId), json }),
      async delete(args) {
        await http.send(routes.deleteQueuedMessage, queued(args));
        return { ok: true };
      },
      list: ({ threadId, signal }) =>
        http.json(routes.queuedMessages, at(threadId), signal),
      send: (args) =>
        http.json(routes.sendQueuedMessage, {
          ...queued(args),
          json: { mode: args.mode },
        }),
      update({ queuedMessageId, threadId, ...json }) {
        const target = queued({ queuedMessageId, threadId });
        return http.json(routes.updateQueuedMessage, { ...target, json });
      },
    },
    reorderPinned: (args) =>
      http.json(routes.pinOrder, {
        ...at(args.threadId),
        json: pick(args, ["previousThreadId", "nextThreadId"]),
      }),
    resolveMentions: ({ threadIds, signal }) =>
      http.json(routes.resolveMentions, { json: { threadIds } }, signal),
    restoreEnvironment: ({ threadId }) =>
      http.json(routes.restoreEnvironment, at(threadId)),
    search: (args) =>
      http.json(
        routes.search,
        { query: pick(args, ["limitPerGroup", "query"]) },
        args.signal,
      ),
    send: (args) =>
      http.json(routes.send, {
        ...at(args.threadId),
        json: pick(args, [
          "input",
          "mode",
          "model",
          "permissionMode",
          "reasoningLevel",
          "senderThreadId",
          "serviceTier",
          "pluginSubmission",
          "executionInputSources",
          "sendAt",
        ]),
      }),
    spawn: (args) => http.json(routes.create, { json: spawnJson(args) }),
    stop: acknowledged(routes.stop),
    tabs: {
      async get({ threadId, signal }) {
        const body = await http.json(routes.tabs, at(threadId), signal);
        return threadTabsResponseSchema.parse(body);
      },
      async update(args) {
        const json = pick(args, ["expectedRevision", "tabs"]);
        const input = { ...at(args.threadId), json };
        const body = await http.json(routes.updateTabs, input);
        return threadTabsResponseSchema.parse(body);
      },
    },
    timeline(args) {
      const query = pick(args, [
        "includeNestedRows",
        "summaryOnly",
        "segmentLimit",
        "beforeAnchorSeq",
        "beforeAnchorId",
        "afterSequence",
      ]);
      const input = { ...at(args.threadId), query };
      return http.json(routes.timeline, input, args.signal);
    },
    timelineTurnSummaryDetails(args) {
      const query = pick(args, [
        "turnId",
        "sourceSeqStart",
        "sourceSeqEnd",
        "beforeCursor",
      ]);
      const input = { ...at(args.threadId), query };
      return http.json(routes.timelineTurnSummaryDetails, input, args.signal);
    },
    storagePaths(args) {
      const query = pick(args, [
        "query",
        "limit",
        "includeFiles",
        "includeDirectories",
      ]);
      const input = { ...at(args.threadId), query };
      return http.json(routes.storagePaths, input, args.signal);
    },
    unarchive: acknowledged(routes.unarchive),
    unpin: ({ threadId }) => http.json(routes.unpin, at(threadId)),
    update: (args) =>
      http.json(routes.update, {
        ...at(args.threadId),
        json: pick(args, [
          "title",
          "sectionId",
          "parentThreadId",
          "model",
          "reasoningLevel",
          "visibility",
        ]),
      }),
    wait,
  };
}
