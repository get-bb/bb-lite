import {
  formatToolCallCommand,
  isBackgroundAgentTaskType,
  isBackgroundCommandTaskType,
  isSettledWorkflowAgentState,
  isNamespacedGlyph,
} from "@bb/domain";
import type {
  TimelineActivityIntent,
  TimelineApprovalStatus,
  TimelineCommandWorkRow,
  TimelineFileChange,
  TimelineFileChangeWorkRow,
  TimelineFileReadWorkRow,
  TimelineImageGenerationWorkRow,
  TimelineParentChangeSystemRow,
  TimelinePlanStepsWorkRow,
  TimelineRowPresentation,
  TimelineRowStatus,
  TimelineSearchWorkRow,
  TimelineToolWorkRow,
} from "@bb/server-contract";
import {
  assertNever,
  OWNERSHIP_CHANGE_VERBS,
  FILE_CHANGE_VERBS,
  formatFileChangePath,
  getFileChangeAction,
  durationToCompactString,
  formatDiffStatsText,
  formatTimelineActivityIntentDetailParts,
  getTimelineActivityIntentDetailDedupeKey,
  itemActivityIntent,
  timelineRowActivityIntents,
  type TimelineExplorationWorkRow,
  fileNameFromPath,
  formatTimelinePath,
  type TimelinePathDisplayMode,
  primaryTimelineActivityIntent,
} from "./timeline-format.js";
import {
  buildTimelineWorkSummaryLabelParts,
  type ThreadTimelineViewRow,
  type TimelineWorkSummaryRow,
  type TimelineViewDelegationWorkRow,
  type TimelineQuestionViewWorkRow,
  type TimelineViewTurnRow,
  type TimelineViewWorkRow,
  type TimelineViewWorkflowWorkRow,
} from "./timeline-view.js";

export type TimelineTitleTone = "default" | "summary";

type TimelineStatusDecorationStatus = "denied" | "error" | "interrupted";

type DisplayStatus = "waiting" | "denied" | TimelineRowStatus;

type StatusVerbs = Record<TimelineRowStatus, string>;

export type TimelineTitleLink = { kind: "thread"; threadId: string };

export type TimelineTitleSegmentAccent = "muted" | "subtle" | "file";

export interface TimelineTitleSegment {
  text: string;
  plainText?: string;
  em: boolean;
  shimmer: boolean;
  truncate: boolean;
  accent?: TimelineTitleSegmentAccent;
  link?: TimelineTitleLink;
}

export type TimelineTitleDecoration =
  | {
      kind: "duration";
      startedAt: number;
      completedAt: number | null;
      em: boolean;
    }
  | {
      kind: "status";
      status: TimelineStatusDecorationStatus;
      durationMs: number | null;
      emphasis: boolean;
    }
  | { kind: "summary-status"; errorCount: number; interruptedCount: number }
  | { kind: "diff-stats"; added: number; removed: number }
  | {
      kind: "badge";
      glyph: string;
      label: string;
      hint: string;
      tone: "neutral" | "destructive";
    };

export type TimelineTitleAction =
  | { kind: "open-file-diff"; path: string }
  | { kind: "open-plugin-side-chat"; threadId: string };

export interface TimelineTitle {
  segments: TimelineTitleSegment[];
  decorations: TimelineTitleDecoration[];
  tone: TimelineTitleTone;
  action: TimelineTitleAction | null;
  plain: string;
}

export interface BuildTimelineRowTitleOptions {
  summaryStyle: "bundle" | "background";
  workStyle: "default" | "summary";
  isActiveLatestBundle?: boolean;
}

export interface TimelineActivityIntentTitle {
  id: string;
  intent: TimelineActivityIntent;
  title: TimelineTitle;
  intentType: "read" | "list_files" | "search";
}

type TimedRow = { startedAt: number; completedAt: number | null };

type TimelineApprovalWorkRow = Extract<
  TimelineViewWorkRow,
  { workKind: "approval" }
>;

type TimelineSystemViewRow = Extract<ThreadTimelineViewRow, { kind: "system" }>;

function collapseTitleNewlines(text: string): string {
  return text.replace(/[\r\n]+/gu, " ");
}

function segment(
  text: string,
  opts: {
    em?: boolean;
    shimmer?: boolean;
    truncate?: boolean;
    plainText?: string;
    link?: TimelineTitleLink;
    accent?: TimelineTitleSegmentAccent;
  } = {},
): TimelineTitleSegment {
  return {
    text: collapseTitleNewlines(text),
    em: opts.em ?? false,
    shimmer: opts.shimmer ?? false,
    truncate: opts.truncate ?? false,
    ...(opts.plainText !== undefined
      ? { plainText: collapseTitleNewlines(opts.plainText) }
      : {}),
    ...(opts.link !== undefined ? { link: opts.link } : {}),
    ...(opts.accent !== undefined ? { accent: opts.accent } : {}),
  };
}

function emphasized(text: string): TimelineTitleSegment {
  return segment(text, { em: true, truncate: true });
}

function verbSegment(
  verbs: StatusVerbs,
  status: TimelineRowStatus,
): TimelineTitleSegment {
  return segment(verbs[status], { shimmer: status === "pending" });
}

function filterNull<T>(values: (T | null)[]): T[] {
  return values.filter((v): v is T => v !== null);
}

function visibleDurationMs(durationMs: number | null): number | null {
  return durationMs !== null && durationMs > 1_000 ? durationMs : null;
}

function elapsedMs(row: TimedRow): number | null {
  return row.completedAt !== null ? row.completedAt - row.startedAt : null;
}

function durationDecorations(
  row: TimedRow,
  em = false,
): TimelineTitleDecoration[] {
  const { startedAt, completedAt } = row;
  return visibleDurationMs(elapsedMs(row)) === null && completedAt !== null
    ? []
    : [{ kind: "duration", startedAt, completedAt, em }];
}

function badgeDecorations(row: {
  presentation?: TimelineRowPresentation;
}): TimelineTitleDecoration[] {
  const badge = row.presentation?.badge;
  return badge === undefined
    ? []
    : [
        {
          kind: "badge",
          glyph: badge.glyph,
          label: badge.label,
          hint: badge.hint,
          tone: badge.tone,
        },
      ];
}

function statusDecoration(
  status: TimelineStatusDecorationStatus,
  durationMs: number | null,
  emphasis = false,
): TimelineTitleDecoration {
  return {
    kind: "status",
    status,
    durationMs: visibleDurationMs(durationMs),
    emphasis,
  };
}

function settledDecorations(
  status: DisplayStatus,
  row: TimedRow,
): TimelineTitleDecoration[] {
  return status === "error" || status === "interrupted"
    ? [statusDecoration(status, elapsedMs(row))]
    : durationDecorations(row);
}

function summaryStatusDecoration(
  row: TimelineWorkSummaryRow,
): TimelineTitleDecoration | null {
  let errorCount = 0;
  let interruptedCount = 0;
  for (const child of row.children) {
    if (child.status === "error") errorCount += 1;
    if (child.status === "interrupted") interruptedCount += 1;
  }
  if (errorCount === 0 && interruptedCount === 0) return null;
  return { kind: "summary-status", errorCount, interruptedCount };
}

function diffStatsDecorations(
  change: TimelineFileChange,
): TimelineTitleDecoration[] {
  const { added, removed } = change.diffStats;
  return added === 0 && removed === 0
    ? []
    : [{ kind: "diff-stats", added, removed }];
}

export function formatTimelineDecorationText(
  d: TimelineTitleDecoration,
): string {
  switch (d.kind) {
    case "duration": {
      if (d.completedAt === null) return "";
      return `(${durationToCompactString(d.completedAt - d.startedAt)})`;
    }
    case "status":
      return d.durationMs !== null
        ? `(${durationToCompactString(d.durationMs)}, ${d.status})`
        : `(${d.status})`;
    case "summary-status": {
      const parts: string[] = [];
      if (d.errorCount > 0) {
        parts.push(`${d.errorCount} error${d.errorCount > 1 ? "s" : ""}`);
      }
      if (d.interruptedCount > 0) {
        parts.push(`${d.interruptedCount} interrupted`);
      }
      return parts.length === 0 ? "" : `(${parts.join(", ")})`;
    }
    case "diff-stats":
      return formatDiffStatsText({
        added: d.added,
        removed: d.removed,
        hideZero: true,
      });
    case "badge":
      return `(${d.label})`;
    default:
      return assertNever(d);
  }
}

function renderTitlePlain(
  segments: readonly TimelineTitleSegment[],
  decorations: readonly TimelineTitleDecoration[],
): string {
  const segmentsText = segments
    .map((s) => s.plainText ?? s.text)
    .filter((t) => t.length > 0)
    .join(" ");
  const decorationsText = decorations
    .map(formatTimelineDecorationText)
    .filter((t) => t.length > 0)
    .join(" ");
  if (decorationsText.length === 0) return segmentsText;
  if (segmentsText.length === 0) return decorationsText;
  return `${segmentsText} ${decorationsText}`;
}

function makeTitle(
  segments: TimelineTitleSegment[],
  decorations: TimelineTitleDecoration[] = [],
  action: TimelineTitleAction | null = null,
  tone: TimelineTitleTone = "default",
): TimelineTitle {
  return {
    segments,
    decorations,
    tone,
    action,
    plain: renderTitlePlain(segments, decorations),
  };
}

function displayStatus(
  approvalStatus: TimelineApprovalStatus,
  status: TimelineRowStatus,
): DisplayStatus {
  if (approvalStatus === "waiting_for_approval") return "waiting";
  return approvalStatus === "denied" ? "denied" : status;
}

function presentedTitle(
  presentation: TimelineRowPresentation,
  row: TimedRow & { status: TimelineRowStatus },
  options: {
    content?: string | null;
    plainContent?: string;
    em?: boolean;
  } = {},
): TimelineTitle {
  const pending = row.status === "pending";
  const content =
    options.content === undefined ? presentation.title : options.content;
  const segments = [
    segment(
      pending ? presentation.label.pending : presentation.label.completed,
      { shimmer: pending, truncate: !content },
    ),
  ];
  if (content) {
    segments.push(
      segment(content, {
        em: options.em ?? true,
        truncate: true,
        ...(options.plainContent === undefined
          ? {}
          : { plainText: options.plainContent }),
      }),
    );
  }
  return makeTitle(segments, [
    ...badgeDecorations({ presentation }),
    ...settledDecorations(row.status, row),
  ]);
}

function mapExecutionTitle(
  row: TimelineCommandWorkRow | TimelineToolWorkRow,
): TimelineTitle {
  const status = displayStatus(row.approvalStatus, row.status);
  const isCommand = row.workKind === "command";
  if (
    row.presentation &&
    status !== "waiting" &&
    status !== "denied" &&
    !isCommand
  ) {
    return presentedTitle(row.presentation, row);
  }
  const explorationTitle =
    row.workKind === "command" ? mapSingleExplorationIntentTitle(row) : null;
  if (explorationTitle !== null) return explorationTitle;
  const content = emphasized(
    isCommand ? row.command : formatToolCallCommand(row.toolName, row.toolArgs),
  );
  const badges = badgeDecorations(row);
  if (status === "waiting") {
    return makeTitle(
      [
        segment("Waiting for approval", { shimmer: true }),
        segment(isCommand ? "to run" : "to use"),
        content,
      ],
      badges,
    );
  }
  const lead =
    status === "denied"
      ? segment("Permission denied:")
      : status === "pending"
        ? segment(isCommand ? "Running" : "Running tool:", { shimmer: true })
        : segment(isCommand ? "Ran" : "Ran tool");
  return makeTitle(
    [lead, content],
    [...badges, ...settledDecorations(status, row)],
  );
}

function joinedIntentDetail(
  intent: TimelineActivityIntent,
  pathMode: TimelinePathDisplayMode,
): string {
  const { prefix, content } = formatTimelineActivityIntentDetailParts({
    intent,
    pathMode,
    pending: false,
  });
  return prefix ? `${prefix} ${content}` : content;
}

function mapTimelineActivityIntentTitle(
  intent: TimelineActivityIntent,
  pending: boolean,
  failureStatus: "error" | "interrupted" | undefined,
  badges: readonly TimelineTitleDecoration[],
): TimelineTitle {
  const detail = formatTimelineActivityIntentDetailParts({
    intent,
    pathMode: "compact",
    pending,
  });
  const plainDetail = formatTimelineActivityIntentDetailParts({
    intent,
    pathMode: "full",
    pending,
  });
  const segments: TimelineTitleSegment[] = [];
  if (detail.prefix) {
    segments.push(segment(detail.prefix, { shimmer: pending }));
  }
  segments.push(
    segment(detail.content, {
      em: false,
      truncate: true,
      plainText: plainDetail.content,
    }),
  );
  return makeTitle(segments, [
    ...badges,
    ...(failureStatus ? [statusDecoration(failureStatus, null)] : []),
  ]);
}

function explorationIntentTitle(
  row: TimelineExplorationWorkRow,
  intent: TimelineActivityIntent,
): TimelineTitle {
  const status = displayStatus(
    row.workKind === "command" ? row.approvalStatus : null,
    row.status,
  );
  const badges = badgeDecorations(row);
  if (status === "denied" || status === "waiting") {
    const subject = segment(joinedIntentDetail(intent, "compact"), {
      em: true,
      truncate: true,
      plainText: joinedIntentDetail(intent, "full"),
    });
    return makeTitle(
      status === "denied"
        ? [segment("Permission denied:"), subject]
        : [
            segment("Waiting for approval", { shimmer: true }),
            segment("to use"),
            subject,
          ],
      badges,
    );
  }
  return mapTimelineActivityIntentTitle(
    intent,
    status === "pending",
    status === "error" || status === "interrupted" ? status : undefined,
    badges,
  );
}

function mapSingleExplorationIntentTitle(
  row: TimelineCommandWorkRow,
): TimelineTitle | null {
  const [intent, ...others] = row.activityIntents.filter(
    (candidate) => candidate.type !== "unknown",
  );
  return intent && others.length === 0
    ? explorationIntentTitle(row, intent)
    : null;
}

function fileChangeLeadSegments(
  row: TimelineFileChangeWorkRow,
  status: DisplayStatus,
): TimelineTitleSegment[] {
  const verbs = FILE_CHANGE_VERBS[getFileChangeAction(row.change)];
  switch (status) {
    case "waiting":
      return [
        segment("Waiting for approval", { shimmer: true }),
        segment("to edit"),
      ];
    case "denied":
      return [segment("Permission denied:")];
    case "pending":
      return [segment(verbs.present, { shimmer: true })];
    case "completed":
      return [segment(verbs.past)];
    case "error":
      return [segment(`Failed to ${verbs.infinitive}`)];
    case "interrupted":
      return [segment(`Interrupted while ${verbs.present.toLowerCase()}`)];
  }
}

function mapFileChangeTitle(row: TimelineFileChangeWorkRow): TimelineTitle {
  const status = displayStatus(row.approvalStatus, row.status);
  const pathSegment = segment(
    formatFileChangePath({ change: row.change, mode: "compact" }),
    {
      em: true,
      truncate: true,
      plainText: formatFileChangePath({ change: row.change, mode: "full" }),
      accent: "file",
    },
  );
  return makeTitle(
    [...fileChangeLeadSegments(row, status), pathSegment],
    status === "error"
      ? [statusDecoration("error", null)]
      : status === "interrupted"
        ? []
        : diffStatsDecorations(row.change),
    { kind: "open-file-diff", path: row.change.movePath ?? row.change.path },
  );
}

const WEB_SEARCH_VERBS: StatusVerbs = {
  pending: "Running web search:",
  completed: "Ran web search:",
  error: "Ran web search:",
  interrupted: "Interrupted web search:",
};

const WEB_FETCH_VERBS: StatusVerbs = {
  pending: "Fetching:",
  completed: "Fetched:",
  error: "Fetched:",
  interrupted: "Interrupted fetch:",
};

const IMAGE_VIEW_VERBS: StatusVerbs = {
  pending: "Viewing image:",
  completed: "Viewed image:",
  error: "Viewed image:",
  interrupted: "Interrupted image view:",
};

const IMAGE_GENERATION_LABELS: StatusVerbs = {
  pending: "Generating image",
  completed: "Generated image",
  error: "Image generation failed",
  interrupted: "Interrupted image generation",
};

const DELEGATION_VERBS: StatusVerbs = {
  pending: "Running subagent:",
  completed: "Ran subagent:",
  error: "Failed subagent:",
  interrupted: "Interrupted subagent:",
};

const WORKFLOW_VERBS: StatusVerbs = {
  pending: "Running workflow:",
  completed: "Ran workflow:",
  error: "Failed workflow:",
  interrupted: "Interrupted workflow:",
};

const BACKGROUND_COMMAND_VERBS: StatusVerbs = {
  pending: "Running background command:",
  completed: "Ran background command:",
  error: "Background command failed:",
  interrupted: "Background command interrupted:",
};

const BACKGROUND_AGENT_VERBS: StatusVerbs = {
  pending: "Running background agent:",
  completed: "Ran background agent:",
  error: "Background agent failed:",
  interrupted: "Background agent interrupted:",
};

function mapWebActivityTitle(
  row: TimedRow & { status: TimelineRowStatus },
  verbs: StatusVerbs,
  subject: string,
  plainText?: string,
): TimelineTitle {
  return makeTitle(
    [
      verbSegment(verbs, row.status),
      segment(subject, {
        em: false,
        ...(plainText === undefined ? {} : { plainText }),
        truncate: true,
      }),
    ],
    row.status === "pending" ? [] : settledDecorations(row.status, row),
  );
}

function mapImageGenerationTitle(
  row: TimelineImageGenerationWorkRow,
): TimelineTitle {
  if (row.presentation) return presentedTitle(row.presentation, row);
  return makeTitle(
    [verbSegment(IMAGE_GENERATION_LABELS, row.status)],
    row.status === "error" || row.status === "interrupted"
      ? [statusDecoration(row.status, null)]
      : durationDecorations(row),
  );
}

function mapDelegationTitle(row: TimelineViewDelegationWorkRow): TimelineTitle {
  const description = row.description ?? (row.output.trim() || row.toolName);
  if (row.presentation) {
    return presentedTitle(row.presentation, row, { content: description });
  }
  const segments = [
    verbSegment(DELEGATION_VERBS, row.status),
    emphasized(description),
  ];
  if (row.subagentType) {
    segments.push(
      segment(`(${row.subagentType})`, { em: false, truncate: true }),
    );
  }
  return makeTitle(segments, durationDecorations(row));
}

function mapWorkflowTitle(row: TimelineViewWorkflowWorkRow): TimelineTitle {
  const verbs = isBackgroundCommandTaskType(row.taskType)
    ? BACKGROUND_COMMAND_VERBS
    : isBackgroundAgentTaskType(row.taskType)
      ? BACKGROUND_AGENT_VERBS
      : WORKFLOW_VERBS;
  const isWorkflow = verbs === WORKFLOW_VERBS;
  const segments = [
    verbSegment(verbs, row.status),
    emphasized(
      isWorkflow ? (row.workflowName ?? row.description) : row.description,
    ),
  ];
  const agents = isWorkflow ? (row.workflow?.agents ?? []) : [];
  if (agents.length > 0) {
    const done = agents.filter((agent) =>
      isSettledWorkflowAgentState(agent.state),
    ).length;
    segments.push(segment(`(${done}/${agents.length} agents)`, { em: false }));
  }
  return makeTitle(segments, durationDecorations(row));
}

function mapApprovalTitle(row: TimelineApprovalWorkRow): TimelineTitle {
  if (row.approvalKind === "file-edit") {
    return makeTitle(
      row.lifecycle === "waiting"
        ? [
            segment("Waiting for approval to edit", { shimmer: true }),
            emphasized("files"),
          ]
        : [segment("Permission denied:"), emphasized("file changes")],
    );
  }
  const toolName = row.target.toolName;
  const tool = toolName !== null ? emphasized(toolName) : null;
  switch (row.lifecycle) {
    case "pending":
    case "resolving": {
      const verb = row.lifecycle === "pending" ? "Waiting for" : "Delivering";
      return makeTitle(
        tool
          ? [
              segment(`${verb} permission`, { shimmer: true }),
              segment("to use"),
              tool,
            ]
          : [segment(`${verb} permissions`, { shimmer: true })],
      );
    }
    case "granted": {
      const granted =
        row.grantScope === "turn"
          ? "Permission granted for this turn"
          : row.grantScope === "session"
            ? "Permission granted for this session"
            : "Permission granted";
      return makeTitle(
        tool ? [segment(`${granted}:`), tool] : [segment(granted)],
      );
    }
    case "denied":
      return makeTitle(
        tool
          ? [segment("Permission denied:"), tool]
          : [segment("Permission denied")],
      );
    case "interrupted": {
      const reason = row.statusReason?.trim() || null;
      return makeTitle(
        filterNull([
          segment(
            tool
              ? "Permission grant interrupted:"
              : "Permission grant interrupted",
          ),
          tool,
          reason !== null ? segment(`(${reason})`, { truncate: true }) : null,
        ]),
      );
    }
  }
}

function singleQuestionAnswerSummary(
  row: TimelineQuestionViewWorkRow,
  question: TimelineQuestionViewWorkRow["questions"][number],
): string | null {
  const answer = row.answers?.[question.id];
  if (!answer) return null;
  const parts = answer.selected.map((value) => {
    const option = question.options?.find(
      (candidate) => candidate.value === value,
    );
    return option?.label ?? value;
  });
  if (answer.freeText) parts.push(answer.freeText);
  const text = parts.join(", ");
  return text.length > 0 ? text : null;
}

function mapQuestionTitle(row: TimelineQuestionViewWorkRow): TimelineTitle {
  const question =
    row.questions.length === 1 ? (row.questions[0] ?? null) : null;
  const subject = question
    ? emphasized(question.prompt)
    : segment(`${row.questions.length} questions`, { em: true });
  switch (row.lifecycle) {
    case "pending":
    case "resolving": {
      const verb = row.lifecycle === "pending" ? "Waiting for" : "Delivering";
      return makeTitle([
        segment(question ? `${verb} answer` : `${verb} answers to`, {
          shimmer: true,
        }),
        subject,
      ]);
    }
    case "answered": {
      const answerSummary = question
        ? singleQuestionAnswerSummary(row, question)
        : null;
      return makeTitle(
        filterNull([
          segment("Answered"),
          subject,
          answerSummary
            ? segment(`— ${answerSummary}`, { truncate: true })
            : null,
        ]),
      );
    }
    case "interrupted":
      return makeTitle(
        [segment("Asked"), subject],
        [statusDecoration("interrupted", null)],
      );
  }
}

function mapFormTitle(
  row: Extract<TimelineViewWorkRow, { workKind: "form" }>,
): TimelineTitle {
  const { presentation } = row;
  switch (row.lifecycle) {
    case "pending":
      return makeTitle([
        segment(presentation.label.pending, { shimmer: true }),
      ]);
    case "submitted":
      return makeTitle([
        segment(presentation.title ?? presentation.label.completed, {
          truncate: true,
        }),
      ]);
    case "cancelled":
      return makeTitle(
        [segment(presentation.label.completed, { truncate: true })],
        [statusDecoration("interrupted", null)],
      );
  }
}

function mapFileReadTitle(row: TimelineFileReadWorkRow): TimelineTitle {
  if (row.presentation) {
    return presentedTitle(row.presentation, row, {
      content: formatTimelinePath({ path: row.path, mode: "compact" }),
      plainContent: row.path,
    });
  }
  return explorationIntentTitle(row, itemActivityIntent(row));
}

function searchContent(row: TimelineSearchWorkRow): string {
  const root = row.path ? ` in ${row.path}` : "";
  switch (row.mode) {
    case "content":
      return `for ${row.query}${root}`;
    case "path":
      return `matching ${row.query}${root}`;
    case "list":
      return row.path
        ? `in ${row.path}`
        : row.query.length > 0
          ? `in ${row.query}`
          : "";
  }
}

function mapPlanStepsTitle(row: TimelinePlanStepsWorkRow): TimelineTitle {
  const content =
    row.steps.find((step) => step.status === "active")?.step ?? row.explanation;
  if (row.presentation) {
    return presentedTitle(row.presentation, row, {
      content: row.presentation.title ?? content,
      em: false,
    });
  }
  const completedSteps = row.steps.filter(
    (step) => step.status === "completed",
  ).length;
  return makeTitle(
    [
      segment(row.status === "pending" ? "Updating plan" : "Updated plan", {
        shimmer: row.status === "pending",
      }),
      segment(content ?? `${completedSteps}/${row.steps.length} steps done`, {
        truncate: true,
      }),
    ],
    durationDecorations(row),
  );
}

function mapWorkTitle(row: TimelineViewWorkRow): TimelineTitle {
  switch (row.workKind) {
    case "command":
    case "tool":
      return mapExecutionTitle(row);
    case "file-read":
      return mapFileReadTitle(row);
    case "search":
      return row.presentation
        ? presentedTitle(row.presentation, row, {
            content: searchContent(row),
            em: false,
          })
        : explorationIntentTitle(row, itemActivityIntent(row));
    case "plan-steps":
      return mapPlanStepsTitle(row);
    case "extension":
      return presentedTitle(row.presentation, row, { em: false });
    case "file-change":
      return mapFileChangeTitle(row);
    case "web-search":
      return row.presentation
        ? presentedTitle(row.presentation, row, {
            content: row.queries.join(", "),
            em: false,
          })
        : mapWebActivityTitle(
            row,
            WEB_SEARCH_VERBS,
            row.queries.join(", ") || "web search",
          );
    case "web-fetch":
      return row.presentation
        ? presentedTitle(row.presentation, row, { content: row.url, em: false })
        : mapWebActivityTitle(row, WEB_FETCH_VERBS, row.url);
    case "image-generation":
      return mapImageGenerationTitle(row);
    case "image-view":
      return row.presentation
        ? presentedTitle(row.presentation, row, {
            content: fileNameFromPath(row.path),
            plainContent: row.path,
          })
        : mapWebActivityTitle(
            row,
            IMAGE_VIEW_VERBS,
            fileNameFromPath(row.path),
            row.path,
          );
    case "delegation":
      return mapDelegationTitle(row);
    case "workflow":
      return mapWorkflowTitle(row);
    case "approval":
      return mapApprovalTitle(row);
    case "question":
      return mapQuestionTitle(row);
    case "form":
      return mapFormTitle(row);
    default:
      return assertNever(row);
  }
}

function mapWorkSummaryTitle(
  row: TimelineWorkSummaryRow,
  options: BuildTimelineRowTitleOptions,
): TimelineTitle {
  const isActive =
    row.kind === "bundle-summary" && options.isActiveLatestBundle === true;
  const { verb, rest } = buildTimelineWorkSummaryLabelParts(row, {
    active: isActive,
  });
  const decorations = filterNull([summaryStatusDecoration(row)]);
  if (options.summaryStyle === "background") {
    const labelText = rest.length === 0 ? verb : `${verb} ${rest}`;
    return makeTitle(
      [segment(labelText, { em: false, truncate: true })],
      decorations,
      null,
      "summary",
    );
  }
  const settledAccent: TimelineTitleSegmentAccent | undefined = isActive
    ? undefined
    : "subtle";
  const lead = segment(verb, { shimmer: isActive, accent: settledAccent });
  if (rest.length === 0) {
    return makeTitle([{ ...lead, truncate: true }], decorations);
  }
  return makeTitle(
    [lead, segment(rest, { em: true, truncate: true, accent: settledAccent })],
    decorations,
  );
}

function mapTurnTitle(row: TimelineViewTurnRow): TimelineTitle {
  if (row.status === "pending") {
    return makeTitle(
      [segment("Working", { shimmer: true })],
      durationDecorations(row, true),
    );
  }
  const { startedAt, completedAt } = row;
  return makeTitle(
    [
      segment(completedAt === null ? "Worked" : "Worked for", {
        accent: "subtle",
      }),
    ],
    completedAt === null
      ? []
      : [{ kind: "duration", startedAt, completedAt, em: false }],
  );
}

function parentChangeParentSegment(
  threadId: string | null,
  title: string | null,
): TimelineTitleSegment {
  if (threadId === null) return segment("parent");
  return segment(title ?? threadId, {
    em: true,
    truncate: true,
    link: { kind: "thread", threadId },
  });
}

function parentChangeThreadName(row: TimelineParentChangeSystemRow): string {
  const verb = OWNERSHIP_CHANGE_VERBS[row.parentChange.action];
  const parentTitle =
    row.parentChange.action === "release"
      ? row.parentChange.previousParentThreadTitle
      : row.parentChange.nextParentThreadTitle;
  const parent =
    parentTitle !== null && parentTitle.trim().length > 0
      ? parentTitle.trim()
      : "parent";
  const suffix = ` ${verb} ${parent}`;
  if (row.title.endsWith(suffix) && row.title.length > suffix.length) {
    return row.title.slice(0, row.title.length - suffix.length);
  }
  return row.threadId;
}

function mapParentChangeSystemTitle(
  row: TimelineParentChangeSystemRow,
): TimelineTitle {
  const assignment = row.parentChange;
  const shimmer = row.status === "pending";
  const released = assignment.action === "release";
  return makeTitle(
    [
      segment(parentChangeThreadName(row), {
        em: true,
        truncate: true,
        shimmer,
        ...(row.threadId.length > 0
          ? { link: { kind: "thread", threadId: row.threadId } }
          : {}),
      }),
      segment(OWNERSHIP_CHANGE_VERBS[assignment.action], {
        shimmer,
        accent: "muted",
      }),
      parentChangeParentSegment(
        released
          ? assignment.previousParentThreadId
          : assignment.nextParentThreadId,
        released
          ? assignment.previousParentThreadTitle
          : assignment.nextParentThreadTitle,
      ),
    ],
    row.status === "error"
      ? [statusDecoration("error", null, true)]
      : row.status === "interrupted"
        ? [statusDecoration("interrupted", null)]
        : [],
  );
}

function mapSystemTitle(row: TimelineSystemViewRow): TimelineTitle {
  const hasError = row.systemKind === "error" || row.status === "error";
  if (row.systemKind === "operation" && row.operationKind === "parent-change") {
    return mapParentChangeSystemTitle(row);
  }
  const isReasoning =
    row.systemKind === "operation" && row.operationKind === "reasoning";
  const isCompaction =
    row.systemKind === "operation" && row.operationKind === "compaction";
  const titleText = isReasoning
    ? row.status === "pending"
      ? "Thinking…"
      : "Thought"
    : isCompaction && row.status === "pending"
      ? `${row.title}…`
      : row.title;
  const decorations: TimelineTitleDecoration[] = hasError
    ? [statusDecoration("error", null, true)]
    : isReasoning ||
        (isCompaction &&
          (row.status === "pending" || row.status === "completed"))
      ? durationDecorations(row)
      : [];
  return makeTitle(
    [segment(titleText, { shimmer: row.status === "pending", truncate: true })],
    decorations,
  );
}

export function buildTimelineActivityIntentTitles(
  row: TimelineExplorationWorkRow,
): TimelineActivityIntentTitle[] {
  let lastEmittedKey: string | null = null;
  const titles: TimelineActivityIntentTitle[] = [];
  const badges = badgeDecorations(row);
  const failureStatus =
    row.status === "error" || row.status === "interrupted"
      ? row.status
      : undefined;
  timelineRowActivityIntents(row).forEach((intent, index) => {
    if (intent.type === "unknown") return;
    const dedupeKey = getTimelineActivityIntentDetailDedupeKey(intent);
    if (dedupeKey !== null && dedupeKey === lastEmittedKey) return;
    titles.push({
      id: `${row.id}:activity-intent:${index}`,
      intent,
      intentType: intent.type,
      title: mapTimelineActivityIntentTitle(
        intent,
        row.status === "pending",
        failureStatus,
        titles.length === 0 ? badges : [],
      ),
    });
    lastEmittedKey = dedupeKey;
  });
  return titles;
}

export function findTimelineFrontierRow(
  rows: readonly ThreadTimelineViewRow[],
): ThreadTimelineViewRow | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row) continue;
    if (row.kind === "conversation" && row.role === "user") continue;
    return row;
  }
  return null;
}

export function findActiveLatestBundleId(
  rows: readonly ThreadTimelineViewRow[],
): string | null {
  const frontier = findTimelineFrontierRow(rows);
  return frontier?.kind === "bundle-summary" ? frontier.id : null;
}

export function buildTimelineRowTitle(
  row: ThreadTimelineViewRow,
  options: BuildTimelineRowTitleOptions,
): TimelineTitle {
  switch (row.kind) {
    case "conversation":
      return makeTitle([
        segment(row.role === "user" ? "User" : "Assistant", { em: false }),
      ]);
    case "system":
      return mapSystemTitle(row);
    case "work": {
      const title = mapWorkTitle(row);
      return options.workStyle === "default"
        ? title
        : { ...title, tone: "summary" };
    }
    case "bundle-summary":
    case "step-summary":
      return mapWorkSummaryTitle(row, options);
    case "turn":
      return mapTurnTitle(row);
    default:
      return assertNever(row);
  }
}

export type TimelineWorkRowGlyph =
  | "CircleQuestion"
  | "EditFile"
  | "File"
  | "FileText"
  | "Folder"
  | "Globe"
  | "ListTodo"
  | "Lock"
  | "Palette"
  | "Puzzle"
  | "Search"
  | "Terminal"
  | "UserRoundPlus"
  | "Zap";

const SKILL_FILE_NAME = "SKILL.md";

function isSkillReadIntent(intent: TimelineActivityIntent): boolean {
  if (intent.type !== "read") return false;
  const target = (intent.path ?? intent.name).replaceAll("\\", "/");
  return target.split("/").pop() === SKILL_FILE_NAME;
}

const EXPLORATION_INTENT_GLYPHS = {
  search: "Search",
  read: "FileText",
  list_files: "Folder",
} as const;

const WORK_KIND_GLYPHS: Record<
  Exclude<TimelineViewWorkRow["workKind"], "workflow">,
  TimelineWorkRowGlyph
> = {
  "file-change": "EditFile",
  command: "Terminal",
  tool: "Terminal",
  "file-read": "FileText",
  search: "Search",
  "plan-steps": "ListTodo",
  extension: "Puzzle",
  "web-search": "Search",
  "web-fetch": "Globe",
  "image-generation": "Palette",
  "image-view": "File",
  delegation: "UserRoundPlus",
  approval: "Lock",
  question: "CircleQuestion",
  form: "Puzzle",
};

export function activityIntentTitleGlyph(
  entry: TimelineActivityIntentTitle,
): TimelineWorkRowGlyph {
  return isSkillReadIntent(entry.intent)
    ? "Zap"
    : EXPLORATION_INTENT_GLYPHS[entry.intentType];
}

export function workRowPresentation(
  row: TimelineViewWorkRow,
): TimelineRowPresentation | undefined {
  if (row.workKind === "approval" || row.workKind === "question") {
    return undefined;
  }
  return row.presentation;
}

function fallbackGlyphForWorkRow(
  row: TimelineViewWorkRow,
): TimelineWorkRowGlyph {
  if (
    row.workKind === "command" ||
    row.workKind === "file-read" ||
    row.workKind === "search"
  ) {
    const intent = primaryTimelineActivityIntent(row);
    if (intent !== null && intent.type !== "unknown") {
      return EXPLORATION_INTENT_GLYPHS[intent.type];
    }
  }
  if (row.workKind !== "workflow") return WORK_KIND_GLYPHS[row.workKind];
  if (isBackgroundCommandTaskType(row.taskType)) return "Terminal";
  return isBackgroundAgentTaskType(row.taskType) ? "UserRoundPlus" : "ListTodo";
}

export function workRowGlyph<HostGlyph extends string>(
  row: TimelineViewWorkRow,
  isHostGlyph: (glyph: string) => glyph is HostGlyph,
): HostGlyph | TimelineWorkRowGlyph {
  if (isSkillReadCommandRow(row)) return "Zap";
  const presented = workRowPresentation(row)?.icon.glyph;
  if (presented !== undefined && isHostGlyph(presented)) return presented;
  return fallbackGlyphForWorkRow(row);
}

export function workRowPluginGlyph(
  row: TimelineViewWorkRow,
): string | undefined {
  if (isSkillReadCommandRow(row)) return undefined;
  const presented = workRowPresentation(row)?.icon.glyph;
  return presented !== undefined && isNamespacedGlyph(presented)
    ? presented
    : undefined;
}

function isSkillReadCommandRow(row: TimelineViewWorkRow): boolean {
  return (
    row.workKind === "command" && row.activityIntents.some(isSkillReadIntent)
  );
}
