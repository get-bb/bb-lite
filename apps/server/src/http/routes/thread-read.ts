import {
  defaultFeatureFlags,
  PROMPT_HISTORY_ENTRY_LIMIT,
  takeVisiblePromptHistoryEntries,
  threadEventTypeSchema,
  type PromptHistoryEntry,
  type ThreadEventType,
} from "@bb/domain";
import {
  publicApiRoutes,
  THREAD_COUNT_ROOT_PARENT,
  THREAD_EVENT_LIST_PAGE_SIZE,
  type ThreadSearchResponse,
  type ThreadWithIncludesResponse,
} from "@bb/server-contract";
import type { ServerContext } from "../../context.js";
import {
  lastOutput,
  listEvents,
  toThreadEventRow,
} from "../../db/event-read.js";
import { getAppSettings } from "../../db/settings.js";
import {
  countThreads,
  findEnvironment,
  findHost,
  findInteraction,
  findPublicThread,
  getProjectExecutionDefaults,
  hasThreadAttention,
  listOpenInteractions,
  listPromptHistoryEntries,
  listQueuedMessages,
  listSidebarProjects,
  listSidebarThreadRows,
  listThreadMentionRows,
  listThreadRows,
  listThreadRowsByIds,
  listThreadSections,
  recordExists,
  threadChildSummary,
  type SidebarProject,
  type ThreadListRow,
} from "../../db/thread-read.js";
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
  type ThreadDisplayDeps,
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

function flag(value: "true" | "false" | undefined): boolean | undefined {
  return value === undefined ? undefined : value === "true";
}

function positive(value: string | undefined, name: string, fallback: number) {
  const parsed = integer(value) ?? fallback;
  if (parsed <= 0) throw invalidRequest(`${name} must be positive`);
  return parsed;
}

function threadNotFound(): ApiError {
  return new ApiError(404, "thread_not_found", "Thread not found");
}

function mentionLabel(thread: {
  id: string;
  title: string | null;
  titleFallback: string | null;
}): string {
  const named = [thread.title, thread.titleFallback].find(
    (name) => name !== null && name.trim().length > 0,
  );
  return named ?? `Thread ${thread.id.slice(0, 8)}`;
}

export function registerThreadReadRoutes(
  app: ApiApp,
  ctx: ServerContext,
): void {
  const { get, post } = typedApi(app);
  const { db } = ctx;
  const { threads, projects, system } = publicApiRoutes;
  const display: ThreadDisplayDeps = {
    db,
    isHostConnected: (hostId) => ctx.runners.isConnected(hostId),
  };
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
      const timer = setTimeout(wake, timeoutMs);
      timer.unref();
      waiters.add(wake);
    });
  }

  function requireThread(threadId: string): ThreadListRow {
    const thread = findPublicThread(db, threadId);
    if (thread === undefined) throw threadNotFound();
    return thread;
  }

  function requireProject(projectId: string): void {
    if (recordExists(db, "projects", projectId)) return;
    throw new ApiError(404, "project_not_found", "Project not found");
  }

  function timelineDisplay(thread: ThreadListRow): TimelineDisplay {
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
    const rows = listThreadRowsByIds(db, threadIds);
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
    const accepted = listPromptHistoryEntries(db, scope, rowLimit);
    const entries = [...queued, ...accepted].sort(
      (left, right) => right.createdAt - left.createdAt,
    );
    return takeVisiblePromptHistoryEntries({ entries, limit: wanted });
  }

  get(projects.sidebarBootstrap, (c) => {
    const sidebar = listSidebarProjects(db);
    const entries = toThreadListEntries(display, listSidebarThreadRows(db));
    const withThreads = (project: SidebarProject) => ({
      ...project,
      threads: entries.filter((thread) => thread.projectId === project.id),
    });
    return c.json({
      sections: listThreadSections(db),
      projects: sidebar.projects.map(withThreads),
      personalProject: withThreads(sidebar.personalProject),
    });
  });

  get(projects.defaultExecutionOptions, (c) => {
    const defaults = getProjectExecutionDefaults(db, c.req.param("id"));
    if (defaults === undefined) requireProject(c.req.param("id"));
    return c.json(defaults ?? null);
  });

  get(projects.promptHistory, (c, query) => {
    const projectId = c.req.param("id");
    requireProject(projectId);
    return c.json(promptHistory({ projectId }, query?.limit, []));
  });

  get(system.attention, (c) =>
    c.json({ hasAttention: hasThreadAttention(db) }),
  );

  get(threads.list, (c, query = {}) => {
    const { sectionId, projectId } = query;
    const unsectioned = flag(query.unsectioned);
    if (sectionId !== undefined && unsectioned === true) {
      throw invalidRequest("sectionId and unsectioned cannot be used together");
    }
    if (projectId !== undefined) requireProject(projectId);
    const sectionMissing =
      sectionId !== undefined &&
      !recordExists(db, "thread_sections", sectionId);
    if (sectionMissing) {
      throw new ApiError(404, "section_not_found", "Section not found");
    }
    const offset = integer(query.offset);
    const limit =
      query.limit === undefined ? undefined : positive(query.limit, "limit", 1);
    const rows = listThreadRows(db, {
      ...query,
      unsectioned,
      includeHidden: flag(query.includeHidden),
      archived: flag(query.archived),
      hasParent: flag(query.hasParent),
      limit,
      offset,
    });
    return c.json(toThreadListEntries(display, rows));
  });

  get(threads.count, (c, query = {}) => {
    const { parentThreadId: parent, projectId } = query;
    if (projectId !== undefined) requireProject(projectId);
    const counted = countThreads(db, {
      ...query,
      parentThreadId: parent === THREAD_COUNT_ROOT_PARENT ? null : parent,
      includeArchived: flag(query.includeArchived) === true,
      includeHidden: flag(query.includeHidden) === true,
    });
    return c.json(counted);
  });

  get(threads.search, (c, query) => {
    const text = query.query.trim();
    if (text.replaceAll(/\s/gu, "").length < 2) {
      throw invalidRequest(
        "query must contain at least two non-whitespace characters",
      );
    }
    const limit = positive(
      query.limitPerGroup,
      "limitPerGroup",
      SEARCH_LIMIT_PER_GROUP_DEFAULT,
    );
    if (limit > SEARCH_LIMIT_PER_GROUP_MAX) {
      throw invalidRequest(
        `limitPerGroup must be at most ${SEARCH_LIMIT_PER_GROUP_MAX}`,
      );
    }
    const found = searchThreads(db, text, limit);
    const response: ThreadSearchResponse = {
      active: searchGroup(found.active),
      archived: searchGroup(found.archived),
    };
    return c.json(response);
  });

  post(threads.resolveMentions, (c, payload) => {
    const threadIds = [...new Set(payload.threadIds)];
    const rows = listThreadMentionRows(db, threadIds);
    const resolved = threadIds.flatMap((threadId) => {
      const thread = rows.find((row) => row.id === threadId);
      if (thread === undefined) return [];
      const { projectId } = thread;
      return [{ threadId, projectId, label: mentionLabel(thread) }];
    });
    return c.json(resolved);
  });

  get(threads.get, (c, query) => {
    const thread = requireThread(c.req.param("id"));
    const includes = new Set(query?.include?.split(","));
    const response: ThreadWithIncludesResponse = toThreadResponse(
      display,
      thread,
    );
    const { environmentId } = thread;
    const environment =
      includes.size === 0 || environmentId === null
        ? null
        : (findEnvironment(db, environmentId) ?? null);
    if (includes.has("environment")) response.environment = environment;
    if (includes.has("host")) {
      const hostId = environment?.hostId ?? "";
      const found = findHost(db, hostId, ctx.runners.isConnected(hostId));
      response.host =
        found === undefined || found.destroyed ? null : found.host;
      response.environmentHostName = found?.host.name ?? null;
    }
    return c.json(response);
  });

  get(threads.childSummary, (c) =>
    c.json(threadChildSummary(db, requireThread(c.req.param("id")).id)),
  );

  get(threads.timeline, (c, query = {}) => {
    const thread = requireThread(c.req.param("id"));
    const segmentLimit = integer(query.segmentLimit) ?? DEFAULT_SEGMENT_LIMIT;
    if (segmentLimit <= 0) {
      throw invalidRequest("segmentLimit must be a positive integer");
    }
    if (segmentLimit > MAX_SEGMENT_LIMIT) {
      throw invalidRequest(
        `segmentLimit must be less than or equal to ${MAX_SEGMENT_LIMIT}`,
      );
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
    const thread = requireThread(c.req.param("id"));
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
    const thread = requireThread(c.req.param("id"));
    return c.json(timelines.outline(thread, timelineDisplay(thread)));
  });

  get(threads.output, (c) => {
    const thread = requireThread(c.req.param("id"));
    return c.json({ output: lastOutput(db, thread.id) });
  });

  get(threads.events, (c, query = {}) => {
    const thread = requireThread(c.req.param("id"));
    const pageSize = THREAD_EVENT_LIST_PAGE_SIZE;
    const types = query.types?.split(",") as ThreadEventType[] | undefined;
    const rows = listEvents(db, {
      threadId: thread.id,
      afterSequence: integer(query.afterSeq),
      beforeSequence: integer(query.beforeSeq),
      limit: Math.min(positive(query.limit, "limit", pageSize), pageSize),
      order: query.order,
      types,
    });
    return c.json(rows.map(toThreadEventRow));
  });

  get(threads.eventWait, async (c, query) => {
    const threadId = requireThread(c.req.param("id")).id;
    const type = threadEventTypeSchema.safeParse(query.type);
    if (!type.success) throw invalidRequest("Invalid event type");
    const afterSequence = integer(query.afterSeq);
    const waitMs = integer(query.waitMs) ?? MAX_EVENT_WAIT_MS;
    const deadline = Date.now() + Math.min(waitMs, MAX_EVENT_WAIT_MS);
    for (;;) {
      const types = [type.data];
      const [match] = listEvents(db, {
        threadId,
        afterSequence,
        types,
        limit: 1,
      });
      if (match !== undefined) return c.json(toThreadEventRow(match));
      const remaining = deadline - Date.now();
      if (remaining <= 0) return c.body(null, 204);
      await nextThreadChange(threadId, remaining);
    }
  });

  get(threads.defaultExecutionOptions, (c) => {
    const thread = requireThread(c.req.param("id"));
    return c.json(threadDefaultExecution(db, thread, getAppSettings(db)));
  });

  get(threads.queuedMessages, (c) =>
    c.json(listQueuedMessages(db, requireThread(c.req.param("id")).id)),
  );

  get(threads.interactions, (c) =>
    c.json(listOpenInteractions(db, requireThread(c.req.param("id")).id)),
  );

  get(threads.interaction, (c) => {
    const thread = requireThread(c.req.param("id"));
    const interactionId = c.req.param("interactionId");
    const interaction = findInteraction(db, thread.id, interactionId);
    if (interaction === undefined) throw notFound("Interaction not found");
    return c.json(interaction);
  });

  get(threads.promptHistory, (c, query) => {
    const threadId = requireThread(c.req.param("id")).id;
    const queued = listQueuedMessages(db, threadId).map((message) => ({
      id: `queued-message:${message.id}`,
      createdAt: message.createdAt,
      input: message.content,
    }));
    return c.json(promptHistory({ threadId }, query?.limit, queued));
  });
}
