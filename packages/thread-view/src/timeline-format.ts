import type {
  TimelineActivityIntent,
  TimelineCommandWorkRow,
  TimelineFileReadWorkRow,
  TimelineSearchWorkRow,
} from "@bb/server-contract";

export function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unexpected value: ${String(value)}`);
}

export const OWNERSHIP_CHANGE_VERBS = {
  assign: "assigned to",
  release: "released from",
  transfer: "transferred to",
} as const;

export function getMessageStartedAt(message: {
  createdAt: number;
  startedAt?: number;
}): number {
  return message.startedAt ?? message.createdAt;
}

function getNonEmptyStringField(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function getFirstStringField(
  record: Record<string, unknown> | null,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = getNonEmptyStringField(record, key);
    if (value) return value;
  }
  return undefined;
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function plural(
  count: number,
  singular: string,
  pluralName?: string,
): string {
  return `${count} ${count === 1 ? singular : (pluralName ?? `${singular}s`)}`;
}

export function durationToCompactString(durationMs: number): string;

export function durationToCompactString(durationMs: undefined): undefined;

export function durationToCompactString(
  durationMs: number | undefined,
): string | undefined {
  if (durationMs === undefined) return undefined;
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0s";
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return formatRoundedDurationSeconds(totalSeconds);
}

function formatRoundedDurationSeconds(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

export function messageId(threadId: string, kind: string, key: string): string {
  return `${threadId}:${kind}:${key}`;
}

const DIFF_COUNT_FORMATTER = new Intl.NumberFormat("en-US");

export function formatDiffCount(value: number): string {
  return DIFF_COUNT_FORMATTER.format(value);
}

export function formatDiffStatsText(input: {
  added: number;
  removed: number;
  hideZero?: boolean;
}): string {
  const { added, removed, hideZero = false } = input;
  const addedText = `+${formatDiffCount(added)}`;
  const removedText = `-${formatDiffCount(removed)}`;
  if (!hideZero) return `${addedText} ${removedText}`;
  const parts: string[] = [];
  if (added > 0) parts.push(addedText);
  if (removed > 0) parts.push(removedText);
  return parts.join(" ");
}

export type TimelinePathDisplayMode = "compact" | "full";

export function fileNameFromPath(path: string): string {
  const normalizedPath = path.replaceAll("\\", "/");
  const segments = normalizedPath.split("/");
  const candidate = segments[segments.length - 1];
  return candidate && candidate.length > 0 ? candidate : path;
}

export function directoryFromPath(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash === -1 ? "" : path.slice(0, lastSlash);
}

export function formatTimelinePath({
  mode,
  path,
}: {
  mode: TimelinePathDisplayMode;
  path: string;
}): string {
  switch (mode) {
    case "compact":
      return fileNameFromPath(path);
    case "full":
      return path;
  }
}

export type FileChangeAction = "created" | "deleted" | "renamed" | "edited";

type FileChangeDiffStats = { added: number; removed: number };

interface FileChangeLike {
  path: string;
  kind?: string | null;
  movePath?: string | null;
  diff?: string | null;
}

const EMPTY_DIFF_STATS: FileChangeDiffStats = { added: 0, removed: 0 };

function normalizeFileChangeKind(kind: string | null | undefined): string {
  return (kind ?? "").toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

export function isPatchMetadataLine(line: string): boolean {
  const normalizedLine = line.trimEnd();
  return (
    normalizedLine.startsWith("diff --git ") ||
    normalizedLine.startsWith("index ") ||
    normalizedLine.startsWith("new file mode ") ||
    normalizedLine.startsWith("deleted file mode ") ||
    normalizedLine.startsWith("similarity index ") ||
    normalizedLine.startsWith("rename from ") ||
    normalizedLine.startsWith("rename to ") ||
    normalizedLine.startsWith("--- ") ||
    normalizedLine.startsWith("+++ ") ||
    normalizedLine.startsWith("@@") ||
    normalizedLine === "\\ No newline at end of file"
  );
}

function hasSubstantiveDiff(change: FileChangeLike): boolean {
  const diff = change.diff;
  if (!diff) return false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+") || line.startsWith("-")) return true;
  }
  return false;
}

export function getFileChangeAction(change: FileChangeLike): FileChangeAction {
  if (change.movePath) return hasSubstantiveDiff(change) ? "edited" : "renamed";
  const kind = normalizeFileChangeKind(change.kind);
  if (kind.includes("add") || kind.includes("create")) return "created";
  if (kind.includes("delete") || kind.includes("remove")) return "deleted";
  return "edited";
}

export const FILE_CHANGE_VERBS: Record<
  FileChangeAction,
  { past: string; present: string; infinitive: string }
> = {
  created: { past: "Created", present: "Creating", infinitive: "create" },
  deleted: { past: "Deleted", present: "Deleting", infinitive: "delete" },
  renamed: { past: "Renamed", present: "Renaming", infinitive: "rename" },
  edited: { past: "Edited", present: "Editing", infinitive: "edit" },
};

export function formatFileChangePath({
  change,
  mode,
}: {
  change: FileChangeLike;
  mode: TimelinePathDisplayMode;
}): string {
  const sourcePath = formatTimelinePath({ path: change.path, mode });
  if (!change.movePath) return sourcePath;
  if (getFileChangeAction(change) === "edited") {
    return formatTimelinePath({ path: change.movePath, mode });
  }
  return `${sourcePath} -> ${formatTimelinePath({
    path: change.movePath,
    mode,
  })}`;
}

function countPlainContentLines(diff: string): number {
  return diff
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .filter((line) => !isPatchMetadataLine(line)).length;
}

function hasPatchMetadata(diff: string): boolean {
  return diff.split("\n").some(isPatchMetadataLine);
}

export function getFileChangeDiffStats(
  change: FileChangeLike,
): FileChangeDiffStats {
  const diff = change.diff;
  if (!diff) return EMPTY_DIFF_STATS;
  const action = getFileChangeAction(change);
  const plainContentLineCount = countPlainContentLines(diff);
  if (
    !hasPatchMetadata(diff) &&
    (action === "created" || action === "deleted")
  ) {
    return action === "created"
      ? { added: plainContentLineCount, removed: 0 }
      : { added: 0, removed: plainContentLineCount };
  }
  let added = 0;
  let removed = 0;
  let sawUnifiedDiffLine = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) {
      sawUnifiedDiffLine = true;
      added += 1;
      continue;
    }
    if (line.startsWith("-")) {
      sawUnifiedDiffLine = true;
      removed += 1;
    }
  }
  if (sawUnifiedDiffLine) return { added, removed };
  switch (action) {
    case "created":
      return { added: plainContentLineCount, removed: 0 };
    case "deleted":
      return { added: 0, removed: plainContentLineCount };
    case "renamed":
    case "edited":
      return EMPTY_DIFF_STATS;
  }
}

const AGENT_MESSAGE_ENVELOPE_PATTERN =
  /^\[bb message from thread:([^;\]\s]+)(?:;[^\]]*)?\]\s*/;

export interface AgentMessageEnvelope {
  bodyStart: number;
  senderThreadId: string;
}

export function parseAgentMessageEnvelope(
  text: string,
): AgentMessageEnvelope | null {
  const match = AGENT_MESSAGE_ENVELOPE_PATTERN.exec(text);
  const senderThreadId = match?.[1];
  if (!match || !senderThreadId) return null;
  return { bodyStart: match[0].length, senderThreadId };
}

export type TimelineExplorationWorkRow =
  | TimelineCommandWorkRow
  | TimelineFileReadWorkRow
  | TimelineSearchWorkRow;

type TimelineReadActivityIntent = Extract<
  TimelineActivityIntent,
  { type: "read" }
>;

export function itemActivityIntent(
  row: TimelineFileReadWorkRow | TimelineSearchWorkRow,
): TimelineActivityIntent {
  if (row.workKind === "file-read") {
    return {
      type: "read",
      command: row.cmd ?? row.path,
      name: "fileRead",
      path: row.path,
    };
  }
  return row.mode === "content"
    ? {
        type: "search",
        command: row.cmd ?? row.query,
        query: row.query,
        path: row.path,
      }
    : {
        type: "list_files",
        command: row.cmd ?? row.query,
        path: row.path ?? (row.query.length > 0 ? row.query : null),
      };
}

export function timelineRowActivityIntents(
  row: TimelineExplorationWorkRow,
): readonly TimelineActivityIntent[] {
  return row.workKind === "command"
    ? row.activityIntents
    : [itemActivityIntent(row)];
}

const SKILL_FILE_NAME = "SKILL.md";

const PLUGIN_CACHE_PATH_MARKERS = ["plugins", "cache"];

export function primaryTimelineActivityIntent(
  row: TimelineExplorationWorkRow,
): TimelineActivityIntent | null {
  return (
    timelineRowActivityIntents(row).find(
      (intent) => intent.type !== "unknown",
    ) ?? null
  );
}

export function hasTimelineExplorationIntent(
  row: TimelineExplorationWorkRow,
): boolean {
  return primaryTimelineActivityIntent(row) !== null;
}

function readTarget(intent: TimelineReadActivityIntent): string {
  return intent.path ?? intent.name;
}

function formatReadTarget(
  intent: TimelineReadActivityIntent,
  pathMode: TimelinePathDisplayMode,
): string {
  const target = readTarget(intent);
  if (pathMode === "compact") {
    const skillTarget = formatCompactSkillTarget(target);
    if (skillTarget !== null) return skillTarget;
  }
  return formatTimelinePath({ path: target, mode: pathMode });
}

function formatCompactSkillTarget(path: string): string | null {
  const segments = path.replaceAll("\\", "/").split("/");
  const fileIndex = segments.length - 1;
  if (segments[fileIndex] !== SKILL_FILE_NAME) return null;
  const pluginName = segments[fileIndex - 2];
  if (
    pluginName &&
    segments[fileIndex - 4] === PLUGIN_CACHE_PATH_MARKERS[1] &&
    segments[fileIndex - 5] === PLUGIN_CACHE_PATH_MARKERS[0]
  ) {
    return `${pluginName}/${SKILL_FILE_NAME}`;
  }
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const skillName = segments[index];
    if (skillName && skillName.length > 0) {
      return `${skillName}/${SKILL_FILE_NAME}`;
    }
  }
  return null;
}

export function formatTimelineActivityIntentDetailParts(args: {
  intent: TimelineActivityIntent;
  pathMode: TimelinePathDisplayMode;
  pending: boolean;
}): { prefix: string | null; content: string } {
  const { intent, pathMode, pending } = args;
  switch (intent.type) {
    case "read":
      return {
        prefix: pending ? "Reading" : "Read",
        content: formatReadTarget(intent, pathMode),
      };
    case "list_files":
      return {
        prefix: pending ? "Listing" : "Listed",
        content: intent.path ? `files in ${intent.path}` : "files",
      };
    case "search":
      return {
        prefix: pending ? "Searching" : "Searched",
        content: intent.query
          ? intent.path
            ? `for ${intent.query} in ${intent.path}`
            : `for ${intent.query}`
          : intent.path
            ? `in ${intent.path}`
            : "files",
      };
    case "unknown":
      return { prefix: null, content: intent.command };
    default:
      return assertNever(intent);
  }
}

export function getTimelineActivityIntentDetailDedupeKey(
  intent: TimelineActivityIntent,
): string | null {
  switch (intent.type) {
    case "read":
      return `read:${intent.path ?? intent.name}`;
    case "list_files":
      return `list:${intent.path ?? ""}`;
    case "search":
      return `search:${intent.query ?? ""}|${intent.path ?? ""}`;
    case "unknown":
      return null;
    default:
      return assertNever(intent);
  }
}
