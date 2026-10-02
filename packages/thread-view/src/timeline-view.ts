import type {
  TimelineActivityIntent,
  TimelineConversationRow,
  TimelineDelegationWorkRow,
  TimelineRow,
  TimelineRowBase,
  TimelineRowStatus,
  TimelineSystemRow,
  TimelineTurnRow,
  TimelineWorkRow,
} from "@bb/server-contract";
import {
  FILE_CHANGE_VERBS,
  getFileChangeAction,
  getTimelineActivityIntentDetailDedupeKey,
  hasTimelineExplorationIntent,
  itemActivityIntent,
  plural,
  timelineRowActivityIntents,
} from "./timeline-format.js";

export interface TimelineViewDelegationWorkRow extends Omit<
  TimelineDelegationWorkRow,
  "childRows"
> {
  childRows: ThreadTimelineViewRow[];
  inClosedStep?: boolean;
}

export type TimelineViewWorkRow =
  | (Exclude<TimelineWorkRow, TimelineDelegationWorkRow> & {
      inClosedStep?: boolean;
    })
  | TimelineViewDelegationWorkRow;

export type TimelineViewWorkflowWorkRow = Extract<
  TimelineViewWorkRow,
  { workKind: "workflow" }
>;

type TimelineReasoningSummaryChild = Extract<
  TimelineSystemRow,
  { systemKind: "operation" }
> & { operationKind: "reasoning"; status: "completed" };

export type TimelineWorkSummaryChild =
  | TimelineViewWorkRow
  | TimelineReasoningSummaryChild;

export interface TimelineWorkSummaryRow extends TimelineRowBase {
  kind: "step-summary" | "bundle-summary";
  status: TimelineRowStatus;
  children: TimelineWorkSummaryChild[];
}

export interface TimelineViewTurnRow extends Omit<TimelineTurnRow, "children"> {
  children: ThreadTimelineViewRow[] | null;
}

export type ThreadTimelineViewRow =
  | TimelineConversationRow
  | TimelineViewWorkRow
  | TimelineSystemRow
  | TimelineWorkSummaryRow
  | TimelineViewTurnRow;

type TimelineWorkSummaryCategory =
  | "commands"
  | "delegations"
  | "exploration"
  | "extensions"
  | "fileChanges"
  | "imageGenerations"
  | "imageViews"
  | "planUpdates"
  | "tools"
  | "webResearch";

const WORK_SUMMARY_CATEGORIES: Partial<
  Record<TimelineViewWorkRow["workKind"], TimelineWorkSummaryCategory>
> = {
  tool: "tools",
  "file-read": "exploration",
  search: "exploration",
  "plan-steps": "planUpdates",
  extension: "extensions",
  "file-change": "fileChanges",
  "web-fetch": "webResearch",
  "web-search": "webResearch",
  "image-generation": "imageGenerations",
  "image-view": "imageViews",
  delegation: "delegations",
};

function getTimelineWorkSummaryCategory(
  row: TimelineViewWorkRow,
): TimelineWorkSummaryCategory | null {
  if (row.workKind !== "command") {
    return WORK_SUMMARY_CATEGORIES[row.workKind] ?? null;
  }
  return hasTimelineExplorationIntent(row) ? "exploration" : "commands";
}

function approvalStatusSummaryLabel(
  rows: readonly TimelineViewWorkRow[],
): string | null {
  const statuses = new Set(
    rows.map((row) =>
      row.workKind === "command" ||
      row.workKind === "file-change" ||
      row.workKind === "tool"
        ? row.approvalStatus
        : null,
    ),
  );
  const [status] = statuses;
  if (statuses.size !== 1 || !status) return null;
  const detail = (
    [
      ["command", "command"],
      ["file-change", "file change"],
      ["tool", "tool"],
    ] as const
  )
    .flatMap(([workKind, noun]) => {
      const count = rows.filter((row) => row.workKind === workKind).length;
      return count > 0 ? [plural(count, noun)] : [];
    })
    .join(", ");
  return status === "denied"
    ? `Denied ${detail}`
    : `Waiting for approval on ${detail}`;
}

function explorationSummaryPhrase(
  rows: readonly TimelineViewWorkRow[],
  active: boolean,
): string | null {
  const intents = rows.flatMap((row) =>
    row.workKind === "command" ||
    row.workKind === "file-read" ||
    row.workKind === "search"
      ? timelineRowActivityIntents(row)
      : [],
  );
  const files = new Set(
    intents.flatMap((intent) =>
      intent.type === "read" ? [intent.path ?? intent.name] : [],
    ),
  );
  files.delete("");
  const count = (type: TimelineActivityIntent["type"]) =>
    intents.filter((intent) => intent.type === type).length;
  const counted = {
    read: plural(files.size, "file"),
    search: plural(count("search"), "search", "searches"),
    list_files: plural(count("list_files"), "list"),
  };
  const parts = new Set(
    intents.flatMap((intent) =>
      intent.type === "unknown" ||
      (intent.type === "read" && !(intent.path ?? intent.name))
        ? []
        : [counted[intent.type]],
    ),
  );
  return parts.size === 0
    ? null
    : `${active ? "Exploring" : "Explored"} ${[...parts].join(", ")}`;
}

function fileChangeSummaryPhrase(
  rows: readonly TimelineViewWorkRow[],
  active: boolean,
): string {
  const changes = rows.flatMap((row) =>
    row.workKind === "file-change" ? [row.change] : [],
  );
  const actions = new Set(changes.map(getFileChangeAction));
  const [only = "edited"] = actions;
  const total = new Set(
    changes.map(
      (change) =>
        `${getFileChangeAction(change)}\n${change.movePath ?? change.path}`,
    ),
  ).size;
  const verbs = FILE_CHANGE_VERBS[actions.size === 1 ? only : "edited"];
  return `${active ? verbs.present : verbs.past} ${plural(total, "file")}`;
}

function webResearchSummaryPhrase(
  rows: readonly TimelineViewWorkRow[],
  active: boolean,
): string {
  let queries = 0;
  let pages = 0;
  for (const row of rows) {
    if (row.workKind === "web-search")
      queries += Math.max(1, row.queries.length);
    if (row.workKind === "web-fetch") pages += 1;
  }
  const parts = [
    queries > 0 ? plural(queries, "search query", "search queries") : "",
    pages > 0 ? plural(pages, "web page") : "",
  ].filter(Boolean);
  return `${active ? "Researching" : "Researched"} ${parts.join(", ")}`;
}

const RUN_SUMMARY_NOUNS = {
  commands: "command",
  delegations: "subagent",
  tools: "tool",
  extensions: "plugin step",
};

function summaryPhrase(
  category: TimelineWorkSummaryCategory,
  rows: readonly TimelineViewWorkRow[],
  active: boolean,
): string | null {
  const count = rows.length;
  switch (category) {
    case "exploration":
      return explorationSummaryPhrase(rows, active);
    case "fileChanges":
      return fileChangeSummaryPhrase(rows, active);
    case "webResearch":
      return webResearchSummaryPhrase(rows, active);
    case "imageGenerations":
      return `${active ? "Generating" : "Generated"} ${plural(count, "image")}`;
    case "imageViews":
      return `${active ? "Viewing" : "Viewed"} ${plural(count, "image")}`;
    case "planUpdates":
      return active ? "Updating plan" : `Updated plan ${plural(count, "time")}`;
    default:
      return `${active ? "Running" : "Ran"} ${plural(count, RUN_SUMMARY_NOUNS[category])}`;
  }
}

export function buildTimelineWorkSummaryLabel(
  row: TimelineWorkSummaryRow,
  active: boolean,
): string {
  const work = row.children.filter((child) => child.kind === "work");
  const approvalSummaryLabel = approvalStatusSummaryLabel(work);
  if (approvalSummaryLabel !== null) return approvalSummaryLabel;
  const rowsByCategory = new Map<
    TimelineWorkSummaryCategory,
    TimelineViewWorkRow[]
  >();
  for (const child of work) {
    const category = getTimelineWorkSummaryCategory(child);
    if (!category) continue;
    const rows = rowsByCategory.get(category) ?? [];
    rows.push(child);
    rowsByCategory.set(category, rows);
  }
  const phrases = [...rowsByCategory]
    .map(([category, rows]) => summaryPhrase(category, rows, active))
    .filter((phrase) => phrase !== null);
  if (phrases.length === 0) return active ? "Working" : "Worked";
  return phrases
    .map((phrase, index) =>
      index === 0
        ? phrase
        : `${phrase.charAt(0).toLowerCase()}${phrase.slice(1)}`,
    )
    .join(", ");
}

function mergeTimelineStatus(
  left: TimelineRowStatus,
  right: TimelineRowStatus,
): TimelineRowStatus {
  if (left === "error" || right === "error") return "error";
  if (left === "pending" || right === "pending") return "pending";
  if (left === "interrupted" || right === "interrupted") return "interrupted";
  return "completed";
}

function summarizeRange(
  children: readonly TimelineWorkSummaryChild[],
): TimelineRowBase & { status: TimelineRowStatus } {
  const first = children[0];
  if (!first) {
    throw new Error("Cannot summarize an empty timeline activity run");
  }
  let { sourceSeqStart, sourceSeqEnd, startedAt, createdAt } = first;
  let { turnId, status } = first;
  for (const child of children) {
    sourceSeqStart = Math.min(sourceSeqStart, child.sourceSeqStart);
    sourceSeqEnd = Math.max(sourceSeqEnd, child.sourceSeqEnd);
    startedAt = Math.min(startedAt, child.startedAt);
    createdAt = Math.max(createdAt, child.createdAt);
    status = mergeTimelineStatus(status, child.status);
    if (turnId !== child.turnId) turnId = null;
  }
  return {
    id: [first.threadId, turnId ?? "thread", "work-summary", first.id].join(
      ":",
    ),
    threadId: first.threadId,
    turnId,
    sourceSeqStart,
    sourceSeqEnd,
    startedAt,
    createdAt,
    status,
  };
}

function isSummarizableActivityRow(
  row: ThreadTimelineViewRow,
): row is TimelineWorkSummaryChild {
  if (row.kind === "system") {
    return (
      row.systemKind === "operation" &&
      row.operationKind === "reasoning" &&
      row.status === "completed"
    );
  }
  return (
    row.kind === "work" &&
    row.workKind !== "approval" &&
    row.workKind !== "question" &&
    row.workKind !== "workflow"
  );
}

function isTimelineStepBoundary(row: ThreadTimelineViewRow): boolean {
  return (
    row.kind === "conversation" &&
    !(row.role === "user" && row.turnRequest.status === "pending")
  );
}

function dedupeBundleChildIntents(
  children: TimelineWorkSummaryChild[],
): TimelineWorkSummaryChild[] {
  let lastEmittedKey: string | null = null;
  const out: TimelineWorkSummaryChild[] = [];
  for (const child of children) {
    if (child.kind === "system") {
      lastEmittedKey = null;
      out.push(child);
      continue;
    }
    if (child.workKind === "file-read" || child.workKind === "search") {
      const key = getTimelineActivityIntentDetailDedupeKey(
        itemActivityIntent(child),
      );
      if (key !== null && key === lastEmittedKey) continue;
      lastEmittedKey = key;
      out.push(child);
      continue;
    }
    if (child.workKind !== "command" || child.activityIntents.length === 0) {
      lastEmittedKey = null;
      out.push(child);
      continue;
    }
    const wasExploration = hasTimelineExplorationIntent(child);
    const filtered: TimelineActivityIntent[] = [];
    for (const intent of child.activityIntents) {
      const key = getTimelineActivityIntentDetailDedupeKey(intent);
      if (key !== null && key === lastEmittedKey) continue;
      filtered.push(intent);
      if (intent.type !== "unknown") lastEmittedKey = key;
    }
    if (filtered.length === child.activityIntents.length) {
      out.push(child);
    } else if (
      !wasExploration ||
      filtered.some((intent) => intent.type !== "unknown")
    ) {
      out.push({ ...child, activityIntents: filtered });
    }
  }
  return out;
}

function buildSummaryRow(
  kind: TimelineWorkSummaryRow["kind"],
  children: TimelineWorkSummaryChild[],
): TimelineWorkSummaryRow {
  const dedupedChildren = dedupeBundleChildIntents(children);
  return {
    ...summarizeRange(dedupedChildren),
    kind,
    children: dedupedChildren,
  };
}

function closeOpenStepAtBoundary(
  work: TimelineWorkSummaryChild[],
): ThreadTimelineViewRow[] {
  if (work.length > 1 && work.some((row) => row.kind === "work")) {
    return [buildSummaryRow("step-summary", work)];
  }
  return work.map((row) =>
    row.kind === "work" ? { ...row, inClosedStep: true } : row,
  );
}

function flushOpenStepAsBundles(
  work: TimelineWorkSummaryChild[],
): ThreadTimelineViewRow[] {
  const groups: {
    concept: TimelineWorkSummaryCategory;
    rows: TimelineWorkSummaryChild[];
  }[] = [];
  const leadingThoughts: TimelineWorkSummaryChild[] = [];
  for (const row of work) {
    const last = groups[groups.length - 1];
    if (row.kind === "system") {
      (last?.rows ?? leadingThoughts).push(row);
      continue;
    }
    const concept = getTimelineWorkSummaryCategory(row) ?? "tools";
    if (last && last.concept === concept) {
      last.rows.push(row);
    } else {
      groups.push({ concept, rows: [...leadingThoughts.splice(0), row] });
    }
  }
  return [
    ...leadingThoughts,
    ...groups.map(({ rows }) => {
      const [only] = rows;
      return only && rows.length === 1
        ? only
        : buildSummaryRow("bundle-summary", rows);
    }),
  ];
}

type TimelineViewRowsCache = WeakMap<
  readonly TimelineRow[],
  ThreadTimelineViewRow[]
>;

export function createTimelineViewRowsCache(): TimelineViewRowsCache {
  return new WeakMap();
}

function toTimelineViewRow(
  row: TimelineRow,
  cache: TimelineViewRowsCache,
): ThreadTimelineViewRow {
  if (row.kind === "turn") {
    const children =
      row.children &&
      buildTimelineViewRows(row.children, { cache, closedScope: true });
    return { ...row, children };
  }
  if (row.kind !== "work" || row.workKind !== "delegation") return row;
  const closedScope = row.status !== "pending";
  return {
    ...row,
    childRows: buildTimelineViewRows(row.childRows, { cache, closedScope }),
  };
}

export function buildTimelineViewRows(
  rows: readonly TimelineRow[],
  options: { closedScope?: boolean; cache?: TimelineViewRowsCache } = {},
): ThreadTimelineViewRow[] {
  const cached = options.cache?.get(rows);
  if (cached) return cached;
  const cache = options.cache ?? createTimelineViewRowsCache();
  const result: ThreadTimelineViewRow[] = [];
  let openStep: TimelineWorkSummaryChild[] = [];
  for (const row of rows.map((source) => toTimelineViewRow(source, cache))) {
    if (isSummarizableActivityRow(row)) {
      openStep.push(row);
      continue;
    }
    const closed = isTimelineStepBoundary(row)
      ? closeOpenStepAtBoundary(openStep)
      : flushOpenStepAsBundles(openStep);
    result.push(...closed, row);
    openStep = [];
  }
  result.push(
    ...(options.closedScope
      ? closeOpenStepAtBoundary(openStep)
      : flushOpenStepAsBundles(openStep)),
  );
  options.cache?.set(rows, result);
  return result;
}
