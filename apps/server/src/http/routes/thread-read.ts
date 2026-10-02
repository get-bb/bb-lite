import * as domain from "@bb/domain";
import {
  publicApiRoutes,
  THREAD_EVENT_LIST_PAGE_SIZE,
  type ThreadWithIncludesResponse,
} from "@bb/server-contract";
import type { ServerContext } from "../../context.js";
import { getEnvironment } from "../../db/environments.js";
import * as events from "../../db/event-read.js";
import { findHost, findHostName } from "../../db/hosts.js";
import * as pending from "../../db/pending-interactions.js";
import {
  getProjectExecutionDefaults,
  listStandardProjects,
  requireProject,
} from "../../db/projects.js";
import * as queue from "../../db/queued-messages.js";
import { getAppSettings } from "../../db/settings.js";
import * as store from "../../db/thread-read.js";
import {
  SEARCH_LIMIT_PER_GROUP_DEFAULT,
  SEARCH_LIMIT_PER_GROUP_MAX,
  searchThreads,
  type ThreadSearchGroup,
} from "../../db/thread-search.js";
import {
  listThreadSections,
  requireThreadSection,
} from "../../db/thread-sections.js";
import {
  findProviderDefinition,
  providerPlanCommand,
} from "../../providers/catalog.js";
import { hostResponse } from "../../runners/hosts.js";

import {
  findTurnExecution,
  recordedExecution,
} from "../../threads/execution.js";
import {
  listProjectsWithThreads,
  toThreadListEntries,
  toThreadResponse,
} from "../../threads/thread-display.js";
import type { TimelinePage } from "../../threads/timeline-pages.js";
import {
  createTimelineReader,
  type TimelineDisplay,
} from "../../threads/timeline.js";
import { typedApi, type ApiApp } from "../api.js";
import { invalidRequest, notFound, threadNotFound } from "../errors.js";

const DEFAULT_SEGMENT_LIMIT = 20;
const MAX_SEGMENT_LIMIT = 100;
const MAX_EVENT_WAIT_MS = 30_000;

function integer(value: string | undefined) {
  return value === undefined ? undefined : Number(value);
}

function positive(value: string | undefined, name: string, fallback: number) {
  const parsed = integer(value) ?? fallback;
  if (parsed <= 0) throw invalidRequest(`${name} must be positive`);
  return parsed;
}

function bounded(value: number, name: string, max: number) {
  if (value <= max) return value;
  throw invalidRequest(`${name} must be less than or equal to ${max}`);
}

export function registerThreadReadRoutes(
  app: ApiApp,
  ctx: ServerContext,
): void {
  const { get, post } = typedApi(app);
  const { db } = ctx;
  const { threads, projects } = publicApiRoutes;
  const timelines = createTimelineReader(db);
  const eventWaiters = new Map<string, Set<() => void>>();

  ctx.hub.onChanged((message) => {
    if (message.entity !== "thread") return;
    const { id, changes } = message;
    if (id === undefined) return;
    if (changes.includes("history-rewritten")) timelines.forgetThread(id);
    for (const wake of eventWaiters.get(id) ?? []) wake();
  });

  function nextThreadChange(threadId: string, timeoutMs: number) {
    return new Promise<void>((resolve) => {
      const waiters = eventWaiters.get(threadId) ?? new Set();
      eventWaiters.set(threadId, waiters);
      const wake = () => {
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
    const thread = store.findThreadListRow(db, c.req.param("id"));
    if (thread?.deletedAt === null) return thread;
    throw threadNotFound();
  }

  function timelineDisplay(thread: store.ThreadListRow): TimelineDisplay {
    const { providerId } = thread;
    const settings = getAppSettings(db);
    const provider = findProviderDefinition(db, providerId)?.info;
    return {
      completedTurnDisplay:
        settings.providerCompletedTurnDisplay[providerId] ??
        provider?.completedTurnDisplay ??
        domain.DEFAULT_COMPLETED_TURN_DISPLAY,
      includeDiagnosticOperations: settings.showDiagnosticEvents,
      providerDisplayName: provider?.displayName,
      planCommand: providerPlanCommand(db, providerId),
    };
  }

  function searchGroup(group: ThreadSearchGroup) {
    const threadIds = group.hits.map((hit) => hit.threadId);
    const rows = store.listThreadRowsByIds(db, threadIds);
    const entries = toThreadListEntries(ctx, rows);
    const results = group.hits.flatMap(({ threadId, matches }) => {
      const thread = entries.find((entry) => entry.id === threadId);
      return thread === undefined ? [] : [{ thread, matches }];
    });
    return { total: group.total, results };
  }

  function promptHistory(
    scope: { projectId: string } | { threadId: string },
    limit: string | undefined,
    queued: domain.PromptHistoryEntry[],
  ): domain.PromptHistoryEntry[] {
    const max = domain.PROMPT_HISTORY_ENTRY_LIMIT;
    const wanted = Math.min(positive(limit, "limit", max), max);
    const rowLimit = Math.min(max * 2, wanted + max);
    const accepted = store.listPromptHistoryEntries(db, scope, rowLimit);
    const entries = [...queued, ...accepted].sort(
      (left, right) => right.createdAt - left.createdAt,
    );
    return domain.takeVisiblePromptHistoryEntries({ entries, limit: wanted });
  }

  get(projects.sidebarBootstrap, (c) => {
    const personal = requireProject(db, domain.PERSONAL_PROJECT_ID);
    const listed = [personal, ...listStandardProjects(db)];
    const [personalProject, ...rest] = listProjectsWithThreads(ctx, listed);
    const sections = listThreadSections(db);
    return c.json({ sections, projects: rest, personalProject });
  });

  get(projects.defaultExecutionOptions, (c) => {
    const { id } = requireProject(db, c.req.param("id"));
    return c.json(getProjectExecutionDefaults(db, id));
  });

  get(projects.promptHistory, (c, query) => {
    const { id: projectId } = requireProject(db, c.req.param("id"));
    return c.json(promptHistory({ projectId }, query?.limit, []));
  });

  get(threads.list, (c, query = {}) => {
    const { sectionId } = query;
    if (sectionId !== undefined && query.unsectioned === "true") {
      throw invalidRequest("sectionId and unsectioned cannot be used together");
    }
    if (query.projectId !== undefined) requireProject(db, query.projectId);
    if (sectionId !== undefined) requireThreadSection(db, sectionId);
    if (query.limit !== undefined) positive(query.limit, "limit", 1);
    const rows = store.listThreadRows(db, query);
    return c.json(toThreadListEntries(ctx, rows));
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
    const response: ThreadWithIncludesResponse = toThreadResponse(ctx, thread);
    const { environmentId } = thread;
    const environment =
      includes.size === 0 || environmentId === null
        ? null
        : (getEnvironment(db, environmentId) ?? null);
    if (includes.has("environment")) response.environment = environment;
    if (includes.has("host")) {
      const hostId = environment?.hostId ?? "";
      const host = findHost(db, "id", hostId);
      response.host = host === undefined ? null : hostResponse(ctx, host);
      response.environmentHostName = findHostName(db, hostId);
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
      eventBudget: domain.defaultFeatureFlags.timelineWindowEventBudget,
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
    const type = domain.threadEventTypeSchema.safeParse(query.type);
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

  get(threads.defaultExecutionOptions, (c) => {
    const execution = findTurnExecution(db, requireThread(c), {});
    return c.json(execution && recordedExecution(execution));
  });

  get(threads.queuedMessages, (c) => {
    const rows = queue.listQueuedMessages(db, requireThread(c).id);
    return c.json(rows.map(queue.toThreadQueuedMessage));
  });

  get(threads.interactions, (c) => {
    const rows = pending.listActiveInteractions(db, requireThread(c).id);
    return c.json(rows.map(pending.toPendingInteraction));
  });

  get(threads.interaction, (c) => {
    const threadId = requireThread(c).id;
    const id = c.req.param("interactionId");
    const found = pending.getPendingInteraction(db, id);
    if (found === undefined || found.threadId !== threadId) {
      throw notFound("Interaction not found");
    }
    return c.json(pending.toPendingInteraction(found));
  });

  get(threads.promptHistory, (c, query) => {
    const threadId = requireThread(c).id;
    const queued = queue.listQueuedMessages(db, threadId).map((row) => ({
      id: `queued-message:${row.id}`,
      createdAt: row.createdAt,
      input: queue.parseQueuedContent(row),
    }));
    return c.json(promptHistory({ threadId }, query?.limit, queued));
  });
}
