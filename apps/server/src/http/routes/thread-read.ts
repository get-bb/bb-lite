import {
  defaultFeatureFlags,
  PROMPT_HISTORY_ENTRY_LIMIT,
  takeVisiblePromptHistoryEntries,
  threadEventTypeSchema,
  type PromptHistoryEntry,
} from "@bb/domain";
import {
  publicApiRoutes,
  THREAD_COUNT_ROOT_PARENT,
  THREAD_EVENT_LIST_PAGE_SIZE,
  type ThreadWithIncludesResponse,
} from "@bb/server-contract";
import type { ServerContext } from "../../context.js";
import * as events from "../../db/event-read.js";
import { getAppSettings } from "../../db/settings.js";
import * as store from "../../db/thread-read.js";
import {
  SEARCH_LIMIT_PER_GROUP_DEFAULT,
  SEARCH_LIMIT_PER_GROUP_MAX,
  searchThreads,
  type ThreadSearchGroup,
} from "../../db/thread-search.js";
import {
  providerDisplay,
  threadDefaultExecution,
  toThreadListEntries,
  toThreadResponse,
} from "../../threads/thread-display.js";
import type { TimelinePage } from "../../threads/timeline-pages.js";
import {
  createTimelineReader,
  type TimelineDisplay,
} from "../../threads/timeline.js";
import { typedApi, type ApiApp } from "../api.js";
import { ApiError, invalidRequest, notFound } from "../errors.js";

const DEFAULT_SEGMENT_LIMIT = 20;
const MAX_SEGMENT_LIMIT = 100;
const MAX_EVENT_WAIT_MS = 30_000;

function integer(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

function positive(value: string | undefined, name: string, fallback: number) {
  const parsed = integer(value) ?? fallback;
  if (parsed <= 0) throw invalidRequest(`${name} must be positive`);
  return parsed;
}

function bounded(value: number, name: string, max: number): number {
  if (value <= max) return value;
  throw invalidRequest(`${name} must be less than or equal to ${max}`);
}

export function registerThreadReadRoutes(
  app: ApiApp,
  ctx: ServerContext,
): void {
  const { get, post } = typedApi(app);
  const { db } = ctx;
  const { threads, projects, system } = publicApiRoutes;
  const isHostConnected = (hostId: string): boolean =>
    ctx.runners.isConnected(hostId);
  const display = { db, isHostConnected };
  const timelines = createTimelineReader(db);
  const eventWaiters = new Map<string, Set<() => void>>();

  ctx.hub.onThreadChange((threadId, changes) => {
    if (changes.includes("history-rewritten")) timelines.forgetThread(threadId);
    for (const wake of [...(eventWaiters.get(threadId) ?? [])]) wake();
  });

  function nextThreadChange(threadId: string, timeoutMs: number) {
    return new Promise<void>((resolve) => {
      const waiters = eventWaiters.get(threadId) ?? new Set();
      eventWaiters.set(threadId, waiters);
      const wake = (): void => {
        clearTimeout(timer);
        waiters.delete(wake);
        if (waiters.size === 0) eventWaiters.delete(threadId);
        resolve();
      };
      const timer = setTimeout(wake, timeoutMs).unref();
      waiters.add(wake);
    });
  }

  function requireThread(c: { req: { param(name: "id"): string } }) {
    const thread = store.findPublicThread(db, c.req.param("id"));
    if (thread !== undefined) return thread;
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }

  function requireProject(projectId: string | undefined): void {
    const missing =
      projectId !== undefined && !store.recordExists(db, "projects", projectId);
    if (missing)
      throw new ApiError(404, "project_not_found", "Project not found");
  }

  function timelineDisplay(thread: store.ThreadListRow): TimelineDisplay {
    const settings = getAppSettings(db);
    const provider = providerDisplay(thread.providerId, settings);
    return {
      completedTurnDisplay: provider.completedTurnDisplay,
      includeDiagnosticOperations: settings.showDiagnosticEvents,
      providerDisplayName: provider.displayName,
      planCommand: provider.planCommand,
    };
  }

  function searchGroup(group: ThreadSearchGroup) {
    const threadIds = group.hits.map((hit) => hit.threadId);
    const rows = store.listThreadRowsByIds(db, threadIds);
    const entries = toThreadListEntries(display, rows);
    const results = group.hits.flatMap(({ threadId, matches }) => {
      const thread = entries.find((entry) => entry.id === threadId);
      return thread === undefined ? [] : [{ thread, matches }];
    });
    return { total: group.total, results };
  }

  function promptHistory(
    scope: { projectId: string } | { threadId: string },
    limit: string | undefined,
    queued: PromptHistoryEntry[],
  ): PromptHistoryEntry[] {
    const max = PROMPT_HISTORY_ENTRY_LIMIT;
    const wanted = Math.min(positive(limit, "limit", max), max);
    const rowLimit = Math.min(max * 2, wanted + max);
    const accepted = store.listPromptHistoryEntries(db, scope, rowLimit);
    const entries = [...queued, ...accepted].sort(
      (left, right) => right.createdAt - left.createdAt,
    );
    return takeVisiblePromptHistoryEntries({ entries, limit: wanted });
  }

  get(projects.sidebarBootstrap, (c) => {
    const rows = store.listSidebarThreadRows(db);
    const entries = toThreadListEntries(display, rows);
    const listed = store.listSidebarProjects(db).map((project) => ({
      ...project,
      threads: entries.filter((thread) => thread.projectId === project.id),
    }));
    const personalProject = listed.pop();
    if (personalProject === undefined) throw notFound("No personal project");
    const sections = store.listThreadSections(db);
    return c.json({ sections, projects: listed, personalProject });
  });

  get(projects.defaultExecutionOptions, (c) => {
    const projectId = c.req.param("id");
    const defaults = store.getProjectExecutionDefaults(db, projectId);
    if (defaults === undefined) requireProject(projectId);
    return c.json(defaults ?? null);
  });

  get(projects.promptHistory, (c, query) => {
    const projectId = c.req.param("id");
    requireProject(projectId);
    return c.json(promptHistory({ projectId }, query?.limit, []));
  });

  get(system.attention, (c) =>
    c.json({ hasAttention: store.hasThreadAttention(db) }),
  );

  get(threads.list, (c, query = {}) => {
    const { sectionId } = query;
    if (sectionId !== undefined && query.unsectioned === "true") {
      throw invalidRequest("sectionId and unsectioned cannot be used together");
    }
    requireProject(query.projectId);
    const sectionMissing =
      sectionId !== undefined &&
      !store.recordExists(db, "thread_sections", sectionId);
    if (sectionMissing) {
      throw new ApiError(404, "section_not_found", "Section not found");
    }
    if (query.limit !== undefined) positive(query.limit, "limit", 1);
    const rows = store.listThreadRows(db, query);
    return c.json(toThreadListEntries(display, rows));
  });

  get(threads.count, (c, query = {}) => {
    requireProject(query.projectId);
    const rootsOnly = query.parentThreadId === THREAD_COUNT_ROOT_PARENT;
    return c.json(store.countThreads(db, query, rootsOnly));
  });

  get(threads.search, (c, query) => {
    const text = query.query.trim();
    if (text.replaceAll(/\s/gu, "").length < 2) {
      throw invalidRequest(
        "query must contain at least two non-whitespace characters",
      );
    }
    const limit = bounded(
      positive(
        query.limitPerGroup,
        "limitPerGroup",
        SEARCH_LIMIT_PER_GROUP_DEFAULT,
      ),
      "limitPerGroup",
      SEARCH_LIMIT_PER_GROUP_MAX,
    );
    const found = searchThreads(db, text, limit);
    const active = searchGroup(found.active);
    return c.json({ active, archived: searchGroup(found.archived) });
  });

  post(threads.resolveMentions, (c, payload) => {
    const threadIds = [...new Set(payload.threadIds)];
    const rows = store.listThreadMentionRows(db, threadIds);
    const resolved = threadIds.flatMap((threadId) => {
      const thread = rows.find((row) => row.id === threadId);
      if (thread === undefined) return [];
      const { projectId, title, titleFallback } = thread;
      const named = [title, titleFallback].find(
        (name) => name !== null && name.trim().length > 0,
      );
      const label = named ?? `Thread ${threadId.slice(0, 8)}`;
      return [{ threadId, projectId, label }];
    });
    return c.json(resolved);
  });

  get(threads.get, (c, query) => {
    const thread = requireThread(c);
    const includes = new Set(query?.include?.split(","));
    const response: ThreadWithIncludesResponse = toThreadResponse(
      display,
      thread,
    );
    const { environmentId } = thread;
    const environment =
      includes.size === 0 || environmentId === null
        ? null
        : (store.findEnvironment(db, environmentId) ?? null);
    if (includes.has("environment")) response.environment = environment;
    if (includes.has("host")) {
      const hostId = environment?.hostId ?? "";
      const found = store.findHost(db, hostId, isHostConnected(hostId));
      response.host =
        found === undefined || found.destroyed ? null : found.host;
      response.environmentHostName = found?.host.name ?? null;
    }
    return c.json(response);
  });

  get(threads.childSummary, (c) =>
    c.json(store.threadChildSummary(db, requireThread(c).id)),
  );

  get(threads.timeline, (c, query = {}) => {
    const thread = requireThread(c);
    const segmentLimit = bounded(
      integer(query.segmentLimit) ?? DEFAULT_SEGMENT_LIMIT,
      "segmentLimit",
      MAX_SEGMENT_LIMIT,
    );
    if (segmentLimit <= 0) {
      throw invalidRequest("segmentLimit must be a positive integer");
    }
    const { beforeAnchorSeq, beforeAnchorId: anchorId } = query;
    const page: TimelinePage =
      beforeAnchorSeq === undefined || anchorId === undefined
        ? { kind: "latest", segmentLimit }
        : {
            kind: "older",
            segmentLimit,
            beforeCursor: { anchorSeq: Number(beforeAnchorSeq), anchorId },
          };
    const response = timelines.timeline(thread, {
      ...timelineDisplay(thread),
      page,
      includeNestedRows: query.includeNestedRows === "true",
      summaryOnly: query.summaryOnly === "true",
      eventBudget: defaultFeatureFlags.timelineWindowEventBudget,
      afterSequence: integer(query.afterSequence),
    });
    return c.json(response);
  });

  get(threads.timelineTurnSummaryDetails, (c, query) => {
    const thread = requireThread(c);
    const details = timelines.turnDetails(thread, {
      ...timelineDisplay(thread),
      turnId: query.turnId,
      sourceSeqStart: Number(query.sourceSeqStart),
      sourceSeqEnd: Number(query.sourceSeqEnd),
      beforeCursor: query.beforeCursor,
    });
    return c.json(details);
  });

  get(threads.conversationOutline, (c) => {
    const thread = requireThread(c);
    return c.json(timelines.outline(thread, timelineDisplay(thread)));
  });

  get(threads.output, (c) =>
    c.json({ output: events.lastOutput(db, requireThread(c).id) }),
  );

  get(threads.events, (c, query = {}) => {
    const pageSize = THREAD_EVENT_LIST_PAGE_SIZE;
    const rows = events.listEvents(db, {
      threadId: requireThread(c).id,
      after: integer(query.afterSeq),
      before: integer(query.beforeSeq),
      limit: Math.min(positive(query.limit, "limit", pageSize), pageSize),
      order: query.order,
      types: query.types?.split(","),
    });
    return c.json(rows.map(events.toThreadEventRow));
  });

  get(threads.eventWait, async (c, query) => {
    const threadId = requireThread(c).id;
    const type = threadEventTypeSchema.safeParse(query.type);
    if (!type.success) throw invalidRequest("Invalid event type");
    const types = [type.data];
    const after = integer(query.afterSeq);
    const waitMs = integer(query.waitMs) ?? MAX_EVENT_WAIT_MS;
    const deadline = Date.now() + Math.min(waitMs, MAX_EVENT_WAIT_MS);
    for (;;) {
      const next = { threadId, after, types, limit: 1 };
      const [match] = events.listEvents(db, next);
      if (match !== undefined) return c.json(events.toThreadEventRow(match));
      const remaining = deadline - Date.now();
      if (remaining <= 0) return c.body(null, 204);
      await nextThreadChange(threadId, remaining);
    }
  });

  get(threads.defaultExecutionOptions, (c) =>
    c.json(threadDefaultExecution(requireThread(c), getAppSettings(db))),
  );

  get(threads.queuedMessages, (c) =>
    c.json(store.listQueuedMessages(db, requireThread(c).id)),
  );

  get(threads.interactions, (c) =>
    c.json(store.listInteractions(db, requireThread(c).id)),
  );

  get(threads.interaction, (c) => {
    const interactionId = c.req.param("interactionId");
    const threadId = requireThread(c).id;
    const [found] = store.listInteractions(db, threadId, interactionId);
    if (found === undefined) throw notFound("Interaction not found");
    return c.json(found);
  });

  get(threads.promptHistory, (c, query) => {
    const threadId = requireThread(c).id;
    const queued = store.listQueuedMessages(db, threadId).map((message) => ({
      id: `queued-message:${message.id}`,
      createdAt: message.createdAt,
      input: message.content,
    }));
    return c.json(promptHistory({ threadId }, query?.limit, queued));
  });
}
