import {
  interactions,
  projects,
  threads,
  type PluginServerApi,
} from "@bb/plugin";
import * as domain from "@bb/domain";
import {
  THREAD_EVENT_LIST_PAGE_SIZE,
  type ThreadWithIncludesResponse,
} from "@bb/server-contract";
import { getEnvironment } from "@bb/server-kit/db/environments";
import * as events from "@bb/server-kit/db/event-read";
import { findHost, findHostName } from "@bb/server-kit/db/hosts";
import * as pending from "@bb/server-kit/db/pending-interactions";
import {
  getProjectExecutionDefaults,
  listStandardProjects,
  requireProject,
} from "@bb/server-kit/db/projects";
import * as queue from "@bb/server-kit/db/queued-messages";
import { getAppSettings } from "@bb/server-kit/db/settings";
import * as store from "@bb/server-kit/db/thread-read";
import {
  SEARCH_LIMIT_PER_GROUP_DEFAULT,
  SEARCH_LIMIT_PER_GROUP_MAX,
  searchThreads,
  type ThreadSearchGroup,
} from "@bb/server-kit/db/thread-search";
import {
  listThreadSections,
  requireThreadSection,
} from "@bb/server-kit/db/thread-sections";
import { findProviderDefinition } from "@bb/server-kit/providers/catalog";
import { hostResponse } from "@bb/server-kit/runners/hosts";

import { findTurnExecution, recordedExecution } from "./execution.js";
import {
  listProjectsWithThreads,
  toThreadListEntries,
  toThreadResponse,
} from "@bb/server-kit/threads/thread-display";
import type { TimelinePage } from "./timeline-pages.js";
import { createTimelineReader, type TimelineDisplay } from "./timeline.js";
import {
  invalidRequest,
  notFound,
  threadNotFound,
} from "@bb/server-kit/http/errors";

const DEFAULT_SEGMENT_LIMIT = 20;
const MAX_SEGMENT_LIMIT = 100;
const MAX_EVENT_WAIT_MS = 30_000;

function positive(value: number | undefined, name: string, fallback: number) {
  const parsed = value ?? fallback;
  if (parsed <= 0) throw invalidRequest(`${name} must be positive`);
  return parsed;
}

function bounded(value: number, name: string, max: number) {
  if (value <= max) return value;
  throw invalidRequest(`${name} must be less than or equal to ${max}`);
}

export function implementThreadReads(bb: PluginServerApi): void {
  const { db } = bb;
  const timelines = createTimelineReader(db);
  const eventWaiters = new Map<string, Set<() => void>>();

  bb.realtime.onChanged((message) => {
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

  function requireThread(threadId: string) {
    const thread = store.findThreadListRow(db, threadId);
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
    };
  }

  function searchGroup(group: ThreadSearchGroup) {
    const threadIds = group.hits.map((hit) => hit.threadId);
    const rows = store.listThreadRowsByIds(db, threadIds);
    const entries = toThreadListEntries(bb, rows);
    const results = group.hits.flatMap(({ threadId, matches }) => {
      const thread = entries.find((entry) => entry.id === threadId);
      return thread === undefined ? [] : [{ thread, matches }];
    });
    return { total: group.total, results };
  }

  function promptHistory(
    scope: { projectId: string } | { threadId: string },
    limit: number | undefined,
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

  bb.implement(projects.sidebar, () => {
    const personal = requireProject(db, domain.PERSONAL_PROJECT_ID);
    const listed = [personal, ...listStandardProjects(db)];
    const [personalProject, ...rest] = listProjectsWithThreads(bb, listed);
    const sections = listThreadSections(db);
    return { sections, projects: rest, personalProject };
  });

  bb.implement(projects.defaultExecutionOptions, ({ projectId }) => {
    const { id } = requireProject(db, projectId);
    return getProjectExecutionDefaults(db, id);
  });

  bb.implement(projects.promptHistory, (input) => {
    const { id: projectId } = requireProject(db, input.projectId);
    return promptHistory({ projectId }, input.limit, []);
  });

  bb.implement(threads.list, (query) => {
    const { sectionId } = query;
    if (sectionId !== undefined && query.unsectioned === true) {
      throw invalidRequest("sectionId and unsectioned cannot be used together");
    }
    if (query.projectId !== undefined) requireProject(db, query.projectId);
    if (sectionId !== undefined) requireThreadSection(db, sectionId);
    if (query.limit !== undefined) positive(query.limit, "limit", 1);
    const rows = store.listThreadRows(db, query);
    return toThreadListEntries(bb, rows);
  });

  bb.implement(threads.search, (query) => {
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
    return { active, archived: searchGroup(found.archived) };
  });

  bb.implement(threads.resolveMentions, (payload) => {
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
    return resolved;
  });

  bb.implement(threads.get, ({ threadId, include }) => {
    const thread = requireThread(threadId);
    const includes = new Set(include?.split(","));
    const response: ThreadWithIncludesResponse = toThreadResponse(bb, thread);
    const { environmentId } = thread;
    const environment =
      includes.size === 0 || environmentId === null
        ? null
        : (getEnvironment(db, environmentId) ?? null);
    if (includes.has("environment")) response.environment = environment;
    if (includes.has("host")) {
      const hostId = environment?.hostId ?? "";
      const host = findHost(db, "id", hostId);
      response.host = host === undefined ? null : hostResponse(bb, host);
      response.environmentHostName = findHostName(db, hostId);
    }
    return response;
  });

  bb.implement(threads.childSummary, ({ threadId }) =>
    store.threadChildSummary(db, requireThread(threadId).id),
  );

  bb.implement(threads.timeline, ({ threadId, ...query }) => {
    const thread = requireThread(threadId);
    const segmentLimit = bounded(
      query.segmentLimit ?? DEFAULT_SEGMENT_LIMIT,
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
            beforeCursor: { anchorSeq: beforeAnchorSeq, anchorId },
          };
    return timelines.timeline(thread, {
      ...timelineDisplay(thread),
      page,
      includeNestedRows: query.includeNestedRows === true,
      summaryOnly: query.summaryOnly === true,
      eventBudget: domain.defaultFeatureFlags.timelineWindowEventBudget,
      afterSequence: query.afterSequence,
    });
  });

  bb.implement(threads.timelineTurnSummaryDetails, (query) => {
    const thread = requireThread(query.threadId);
    const { turnId, sourceSeqStart, sourceSeqEnd, beforeCursor } = query;
    const range = { turnId, sourceSeqStart, sourceSeqEnd, beforeCursor };
    return timelines.turnDetails(thread, {
      ...timelineDisplay(thread),
      ...range,
    });
  });

  bb.implement(threads.output, ({ threadId }) => ({
    output: events.lastOutput(db, requireThread(threadId).id),
  }));

  bb.implement(threads.events, ({ threadId, ...query }) => {
    const pageSize = THREAD_EVENT_LIST_PAGE_SIZE;
    const rows = events.listEvents(db, {
      threadId: requireThread(threadId).id,
      after: query.afterSeq,
      before: query.beforeSeq,
      limit: Math.min(positive(query.limit, "limit", pageSize), pageSize),
      order: query.order,
      types: query.types?.split(","),
    });
    return rows.map(events.toThreadEventRow);
  });

  bb.implement(threads.nextEvent, async (query) => {
    const threadId = requireThread(query.threadId).id;
    const type = domain.threadEventTypeSchema.safeParse(query.type);
    if (!type.success) throw invalidRequest("Invalid event type");
    const types = [type.data];
    const after = query.afterSeq;
    const waitMs = query.waitMs ?? MAX_EVENT_WAIT_MS;
    const deadline = Date.now() + Math.min(waitMs, MAX_EVENT_WAIT_MS);
    for (;;) {
      const next = { threadId, after, types, limit: 1 };
      const [match] = events.listEvents(db, next);
      if (match !== undefined) return events.toThreadEventRow(match);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await nextThreadChange(threadId, remaining);
    }
  });

  bb.implement(threads.defaultExecutionOptions, ({ threadId }) => {
    const execution = findTurnExecution(db, requireThread(threadId), {});
    return execution && recordedExecution(execution);
  });

  bb.implement(threads.listQueuedMessages, ({ threadId }) => {
    const rows = queue.listQueuedMessages(db, requireThread(threadId).id);
    return rows.map(queue.toThreadQueuedMessage);
  });

  bb.implement(interactions.list, ({ threadId }) => {
    const rows = pending.listActiveInteractions(db, requireThread(threadId).id);
    return rows.map(pending.toPendingInteraction);
  });

  bb.implement(interactions.get, (input) => {
    const threadId = requireThread(input.threadId).id;
    const found = pending.getPendingInteraction(db, input.interactionId);
    if (found === undefined || found.threadId !== threadId) {
      throw notFound("Interaction not found");
    }
    return pending.toPendingInteraction(found);
  });

  bb.implement(threads.promptHistory, (input) => {
    const threadId = requireThread(input.threadId).id;
    const queued = queue.listQueuedMessages(db, threadId).map((row) => ({
      id: `queued-message:${row.id}`,
      createdAt: row.createdAt,
      input: queue.parseQueuedContent(row),
    }));
    return promptHistory({ threadId }, input.limit, queued);
  });

  bb.implement(threads.recentPrompts, ({ cursor, limit, projectId }) => {
    const wanted = bounded(positive(limit, "limit", 50), "limit", 200);
    const [at = "", id = ""] = cursor?.split(":") ?? [];
    const createdAt = Number(at);
    if (cursor !== undefined && (!Number.isFinite(createdAt) || id === "")) {
      throw invalidRequest("cursor is not valid");
    }
    const before = cursor === undefined ? undefined : { createdAt, id };
    const rows = store.listRecentPrompts(db, {
      projectId,
      before,
      limit: wanted + 1,
    });
    const page = rows.slice(0, wanted);
    const last = page.at(-1);
    const entries = page.map((row) => {
      const text = row.input.flatMap((part) =>
        part.type === "text" && part.text.trim() !== "" ? [part] : [],
      );
      const mentions = text.flatMap((part) => part.mentions);
      return {
        id: row.id,
        text: text.map((part) => part.text).join("\n\n"),
        ...(mentions.length > 0 ? { mentions } : {}),
        threadId: row.threadId,
        projectId: row.projectId,
        scope: row.scope,
        sentAt: row.createdAt,
      };
    });
    const nextCursor =
      rows.length > wanted && last !== undefined
        ? `${last.createdAt}:${last.id}`
        : null;
    return { entries, nextCursor };
  });
}
