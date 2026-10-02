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
  assertNever,
  FILE_CHANGE_VERBS,
  getFileChangeAction,
  type FileChangeAction,
  plural,
  getTimelineActivityIntentDetailDedupeKey,
  hasTimelineExplorationIntent,
  itemActivityIntent,
  timelineRowActivityIntents,
  type TimelineExplorationWorkRow,
} from "./timeline-format.js";

export interface TimelineViewDelegationWorkRow extends Omit<
  TimelineDelegationWorkRow,
  "childRows"
> {
  childRows: ThreadTimelineViewRow[];
  inClosedStep?: boolean;
}

type TimelineViewLeafWorkRow = Exclude<
  TimelineWorkRow,
  TimelineDelegationWorkRow
> & { inClosedStep?: boolean };

export type TimelineViewWorkRow =
  | TimelineViewLeafWorkRow
  | TimelineViewDelegationWorkRow;

export type TimelineQuestionViewWorkRow = Extract<
  TimelineViewWorkRow,
  { workKind: "question" }
>;

export type TimelineViewWorkflowWorkRow = Extract<
  TimelineViewWorkRow,
  { workKind: "workflow" }
>;

type TimelineViewSourceRow =
  | TimelineConversationRow
  | TimelineViewWorkRow
  | TimelineSystemRow;

type TimelineReasoningSummaryChild = Extract<
  TimelineSystemRow,
  { systemKind: "operation" }
> & { operationKind: "reasoning"; status: "completed" };

export type TimelineWorkSummaryChild =
  | TimelineViewWorkRow
  | TimelineReasoningSummaryChild;

export interface TimelineStepSummaryRow extends TimelineRowBase {
  kind: "step-summary";
  status: TimelineRowStatus;
  children: TimelineWorkSummaryChild[];
}

export interface TimelineBundleSummaryRow extends TimelineRowBase {
  kind: "bundle-summary";
  status: TimelineRowStatus;
  children: TimelineWorkSummaryChild[];
}

export type TimelineWorkSummaryRow =
  | TimelineStepSummaryRow
  | TimelineBundleSummaryRow;

export interface TimelineViewTurnRow extends Omit<TimelineTurnRow, "children"> {
  children: ThreadTimelineViewRow[] | null;
}

export type ThreadTimelineViewRow =
  | TimelineViewSourceRow
  | TimelineWorkSummaryRow
  | TimelineViewTurnRow;

type TimelineExplorationKind = "files" | "searches" | "lists";

interface TimelineWorkSummaryCounts {
  commands: number;
  delegations: number;
  extensions: number;
  lists: number;
  planUpdates: number;
  searches: number;
  tools: number;
  webFetches: number;
  webSearches: number;
  imageGenerations: number;
  imageViews: number;
  categories: Set<TimelineWorkSummaryCategory>;
  changedFiles: Record<FileChangeAction, Set<string>>;
  exploredFiles: Set<string>;
  explorationKinds: Set<TimelineExplorationKind>;
}

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

interface TimelineWorkSummaryRange extends TimelineRowBase {
  status: TimelineRowStatus;
}

function lowerFirst(value: string): string {
  return value.length === 0
    ? value
    : `${value.charAt(0).toLowerCase()}${value.slice(1)}`;
}

function countExplorationIntents(
  row: TimelineExplorationWorkRow,
  counts: TimelineWorkSummaryCounts,
): void {
  for (const intent of timelineRowActivityIntents(row)) {
    if (intent.type === "read") {
      const identity = intent.path ?? intent.name;
      if (identity) {
        counts.exploredFiles.add(identity);
        counts.explorationKinds.add("files");
      }
    } else if (intent.type === "list_files") {
      counts.lists += 1;
      counts.explorationKinds.add("lists");
    } else if (intent.type === "search") {
      counts.searches += 1;
      counts.explorationKinds.add("searches");
    }
  }
}

function summarizeTimelineWork(
  rows: readonly TimelineViewWorkRow[],
): TimelineWorkSummaryCounts {
  const counts: TimelineWorkSummaryCounts = {
    commands: 0,
    delegations: 0,
    extensions: 0,
    lists: 0,
    planUpdates: 0,
    searches: 0,
    tools: 0,
    webFetches: 0,
    webSearches: 0,
    imageGenerations: 0,
    imageViews: 0,
    categories: new Set(),
    changedFiles: {
      created: new Set(),
      deleted: new Set(),
      edited: new Set(),
      renamed: new Set(),
    },
    exploredFiles: new Set(),
    explorationKinds: new Set(),
  };
  for (const row of rows) {
    const category = getTimelineWorkSummaryCategory(row);
    if (category) counts.categories.add(category);
    switch (row.workKind) {
      case "command":
        if (category === "exploration") countExplorationIntents(row, counts);
        else counts.commands += 1;
        break;
      case "file-read":
      case "search":
        countExplorationIntents(row, counts);
        break;
      case "file-change":
        counts.changedFiles[getFileChangeAction(row.change)].add(
          row.change.movePath ?? row.change.path,
        );
        break;
      case "web-search":
        counts.webSearches += Math.max(1, row.queries.length);
        break;
      default: {
        const counter = SIMPLE_WORK_COUNTERS[row.workKind];
        if (counter) counts[counter] += 1;
      }
    }
  }
  return counts;
}

const SIMPLE_WORK_COUNTERS: Partial<
  Record<
    TimelineViewWorkRow["workKind"],
    | "delegations"
    | "extensions"
    | "imageGenerations"
    | "imageViews"
    | "planUpdates"
    | "tools"
    | "webFetches"
  >
> = {
  delegation: "delegations",
  extension: "extensions",
  "image-generation": "imageGenerations",
  "image-view": "imageViews",
  "plan-steps": "planUpdates",
  tool: "tools",
  "web-fetch": "webFetches",
};

function approvalStatusSummaryLabel(
  rows: readonly TimelineViewWorkRow[],
): string | null {
  let status: "waiting_for_approval" | "denied" | null = null;
  const counts = { command: 0, "file-change": 0, tool: 0 };
  for (const row of rows) {
    if (
      (row.workKind !== "command" &&
        row.workKind !== "file-change" &&
        row.workKind !== "tool") ||
      row.approvalStatus === null
    ) {
      return null;
    }
    counts[row.workKind] += 1;
    if (status === null) {
      status = row.approvalStatus;
    } else if (status !== row.approvalStatus) {
      return null;
    }
  }
  if (status === null) return null;
  const detail = [
    counts.command > 0 ? plural(counts.command, "command") : null,
    counts["file-change"] > 0
      ? plural(counts["file-change"], "file change")
      : null,
    counts.tool > 0 ? plural(counts.tool, "tool") : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
  return status === "denied"
    ? `Denied ${detail}`
    : `Waiting for approval on ${detail}`;
}

function getTimelineWorkSummaryCategory(
  row: TimelineViewWorkRow,
): TimelineWorkSummaryCategory | null {
  switch (row.workKind) {
    case "command":
      return hasTimelineExplorationIntent(row) ? "exploration" : "commands";
    case "tool":
      return "tools";
    case "file-read":
    case "search":
      return "exploration";
    case "plan-steps":
      return "planUpdates";
    case "extension":
      return "extensions";
    case "file-change":
      return "fileChanges";
    case "web-fetch":
    case "web-search":
      return "webResearch";
    case "image-generation":
      return "imageGenerations";
    case "image-view":
      return "imageViews";
    case "delegation":
      return "delegations";
    case "approval":
    case "question":
    case "form":
    case "workflow":
      return null;
    default:
      return assertNever(row);
  }
}

const FILE_CHANGE_ACTIONS = [
  "created",
  "deleted",
  "edited",
  "renamed",
] as const;

function fileChangeSummaryPhrase(
  counts: TimelineWorkSummaryCounts,
  active: boolean,
): string | null {
  const present = FILE_CHANGE_ACTIONS.filter(
    (action) => counts.changedFiles[action].size > 0,
  );
  const [only] = present;
  if (!only) return null;
  const total = present.reduce(
    (sum, action) => sum + counts.changedFiles[action].size,
    0,
  );
  const verbs = FILE_CHANGE_VERBS[present.length === 1 ? only : "edited"];
  return `${active ? verbs.present : verbs.past} ${plural(total, "file")}`;
}

function countedPhrase(
  count: number,
  verb: string,
  noun: string,
): string | null {
  return count > 0 ? `${verb} ${plural(count, noun)}` : null;
}

function summaryPhrase(
  category: TimelineWorkSummaryCategory,
  counts: TimelineWorkSummaryCounts,
  active: boolean,
): string | null {
  const ran = active ? "Running" : "Ran";
  switch (category) {
    case "exploration": {
      const parts = [...counts.explorationKinds].map((kind) =>
        kind === "files"
          ? plural(counts.exploredFiles.size, "file")
          : kind === "searches"
            ? plural(counts.searches, "search", "searches")
            : plural(counts.lists, "list"),
      );
      return parts.length === 0
        ? null
        : `${active ? "Exploring" : "Explored"} ${parts.join(", ")}`;
    }
    case "commands":
      return countedPhrase(counts.commands, ran, "command");
    case "fileChanges":
      return fileChangeSummaryPhrase(counts, active);
    case "webResearch": {
      const parts: string[] = [];
      if (counts.webSearches > 0) {
        parts.push(
          plural(counts.webSearches, "search query", "search queries"),
        );
      }
      if (counts.webFetches > 0) {
        parts.push(plural(counts.webFetches, "web page"));
      }
      return parts.length === 0
        ? null
        : `${active ? "Researching" : "Researched"} ${parts.join(", ")}`;
    }
    case "imageGenerations":
      return countedPhrase(
        counts.imageGenerations,
        active ? "Generating" : "Generated",
        "image",
      );
    case "imageViews":
      return countedPhrase(
        counts.imageViews,
        active ? "Viewing" : "Viewed",
        "image",
      );
    case "delegations":
      return countedPhrase(counts.delegations, ran, "subagent");
    case "tools":
      return countedPhrase(counts.tools, ran, "tool");
    case "planUpdates":
      return active
        ? counts.planUpdates > 0
          ? "Updating plan"
          : null
        : countedPhrase(counts.planUpdates, "Updated plan", "time");
    case "extensions":
      return countedPhrase(counts.extensions, ran, "plugin step");
    default:
      return assertNever(category);
  }
}

type TimelineWorkSummaryLabelParts = { verb: string; rest: string };

export function buildTimelineWorkSummaryLabelParts(
  row: TimelineWorkSummaryRow,
  options: { active: boolean } = { active: false },
): TimelineWorkSummaryLabelParts {
  const work = row.children.filter((child) => child.kind === "work");
  const approvalSummaryLabel = approvalStatusSummaryLabel(work);
  if (approvalSummaryLabel !== null) {
    return splitVerbAndRest(approvalSummaryLabel);
  }
  const counts = summarizeTimelineWork(work);
  const active = options.active;
  const phrases = [...counts.categories]
    .map((category) => summaryPhrase(category, counts, active))
    .filter((phrase): phrase is string => phrase !== null);
  if (phrases.length === 0) {
    return { verb: active ? "Working" : "Worked", rest: "" };
  }
  return splitVerbAndRest(
    phrases
      .map((phrase, index) => (index === 0 ? phrase : lowerFirst(phrase)))
      .join(", "),
  );
}

function splitVerbAndRest(label: string): TimelineWorkSummaryLabelParts {
  const spaceIndex = label.indexOf(" ");
  if (spaceIndex === -1) return { verb: label, rest: "" };
  return {
    verb: label.slice(0, spaceIndex),
    rest: label.slice(spaceIndex + 1),
  };
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
): TimelineWorkSummaryRange {
  const first = children[0];
  if (!first) {
    throw new Error("Cannot summarize an empty timeline activity run");
  }
  let sourceSeqStart = first.sourceSeqStart;
  let sourceSeqEnd = first.sourceSeqEnd;
  let startedAt = first.startedAt;
  let createdAt = first.createdAt;
  let turnId = first.turnId;
  let status = first.status;
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
  if (
    row.kind === "system" &&
    row.systemKind === "operation" &&
    row.operationKind === "reasoning" &&
    row.status === "completed"
  ) {
    return true;
  }
  return (
    row.kind === "work" &&
    row.workKind !== "approval" &&
    row.workKind !== "question" &&
    row.workKind !== "workflow"
  );
}

function isTimelineStepBoundary(row: ThreadTimelineViewRow): boolean {
  if (row.kind !== "conversation") return false;
  if (row.role === "user" && row.turnRequest.status === "pending") return false;
  return true;
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
      if (intent.type === "unknown") {
        filtered.push(intent);
        continue;
      }
      const key = getTimelineActivityIntentDetailDedupeKey(intent);
      if (key !== null && key === lastEmittedKey) continue;
      filtered.push(intent);
      lastEmittedKey = key;
    }
    if (filtered.length === child.activityIntents.length) {
      out.push(child);
      continue;
    }
    if (
      wasExploration &&
      !filtered.some((intent) => intent.type !== "unknown")
    ) {
      continue;
    }
    out.push({ ...child, activityIntents: filtered });
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
  if (work.length === 0) return [];
  if (!work.some((row) => row.kind === "work")) return work;
  if (work.length === 1) {
    return work.map((row) =>
      row.kind === "work" ? { ...row, inClosedStep: true } : row,
    );
  }
  return [buildSummaryRow("step-summary", work)];
}

function flushOpenStepAsBundles(
  work: TimelineWorkSummaryChild[],
): ThreadTimelineViewRow[] {
  if (work.length === 0) return [];
  interface Group {
    concept: TimelineWorkSummaryCategory;
    rows: TimelineWorkSummaryChild[];
  }
  const groups: Group[] = [];
  const leadingThoughts: TimelineWorkSummaryChild[] = [];
  for (const row of work) {
    if (row.kind === "system") {
      const last = groups[groups.length - 1];
      if (last) last.rows.push(row);
      else leadingThoughts.push(row);
      continue;
    }
    const concept = getTimelineWorkSummaryCategory(row) ?? "tools";
    const last = groups[groups.length - 1];
    if (last && last.concept === concept) {
      last.rows.push(row);
    } else {
      groups.push({ concept, rows: [...leadingThoughts.splice(0), row] });
    }
  }
  const out: ThreadTimelineViewRow[] = [...leadingThoughts];
  for (const group of groups) {
    if (group.rows.length === 1) {
      out.push(group.rows[0]!);
    } else {
      out.push(buildSummaryRow("bundle-summary", group.rows));
    }
  }
  return out;
}

type TimelineViewRowsCache = WeakMap<
  readonly TimelineRow[],
  ThreadTimelineViewRow[]
>;

export function createTimelineViewRowsCache(): TimelineViewRowsCache {
  return new WeakMap();
}

function toTimelineViewWorkRow(
  row: TimelineWorkRow,
  cache: TimelineViewRowsCache,
): TimelineViewWorkRow {
  if (row.workKind !== "delegation") return row;
  const closedScope = row.status !== "pending";
  return {
    ...row,
    childRows: buildTimelineViewRows(row.childRows, { cache, closedScope }),
  };
}

function toTimelineViewRow(
  row: TimelineRow,
  cache: TimelineViewRowsCache,
): ThreadTimelineViewRow {
  switch (row.kind) {
    case "conversation":
    case "system":
      return row;
    case "work":
      return toTimelineViewWorkRow(row, cache);
    case "turn":
      return {
        ...row,
        children: row.children
          ? buildTimelineViewRows(row.children, { cache, closedScope: true })
          : null,
      };
    default:
      return assertNever(row);
  }
}

export interface BuildTimelineViewRowsOptions {
  closedScope?: boolean;
  cache?: TimelineViewRowsCache;
}

export function buildTimelineViewRows(
  rows: readonly TimelineRow[],
  options: BuildTimelineViewRowsOptions = {},
): ThreadTimelineViewRow[] {
  const cache = options.cache;
  if (cache) {
    const cached = cache.get(rows);
    if (cached) return cached;
  }
  const childCache = cache ?? createTimelineViewRowsCache();
  const viewRows = rows.map((row) => toTimelineViewRow(row, childCache));
  const result: ThreadTimelineViewRow[] = [];
  let openStep: TimelineWorkSummaryChild[] = [];
  for (const row of viewRows) {
    if (isSummarizableActivityRow(row)) {
      openStep.push(row);
      continue;
    }
    if (isTimelineStepBoundary(row)) {
      result.push(...closeOpenStepAtBoundary(openStep));
      openStep = [];
      result.push(row);
      continue;
    }
    result.push(...flushOpenStepAsBundles(openStep));
    openStep = [];
    result.push(row);
  }
  if (options.closedScope) {
    result.push(...closeOpenStepAtBoundary(openStep));
  } else {
    result.push(...flushOpenStepAsBundles(openStep));
  }
  if (cache) cache.set(rows, result);
  return result;
}
