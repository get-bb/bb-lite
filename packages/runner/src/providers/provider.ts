import {
  THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH,
  type PendingInteractionPayload,
  type PendingInteractionResolution,
  type PromptInput,
  type ThreadEventItemPresentation as Presentation,
  type ThreadEventTokenUsageBreakdown as TokenUsage,
  type ToolCallResponse,
} from "@bb/domain";
import type { EventBuilder } from "../events/event-builder.js";
import type {
  ExecutionOptions,
  ProviderId,
  ProviderModels,
  ProviderStatus,
  SessionSpec,
} from "../types.js";

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly approvalEnforcedBy: "runner" | "provider";
  status(): Promise<ProviderStatus>;
  listModels(cwd: string | null): Promise<ProviderModels>;
  open(
    spec: SessionSpec,
    options: ExecutionOptions,
    host: SessionHost,
  ): Promise<ProviderSession>;
}

export interface TurnInput {
  clientRequestId: string;
  input: PromptInput[];
  options: ExecutionOptions;
}

export interface ProviderSession {
  readonly providerThreadId: string;
  canApply(spec: SessionSpec, options: ExecutionOptions): boolean;
  startTurn(args: TurnInput): Promise<void>;
  steer(
    args: TurnInput & { expectedTurnId: string },
  ): Promise<"steered" | "stale">;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  rename?(title: string): Promise<void>;
}

export interface SessionHost {
  events: EventBuilder;
  env: Record<string, string>;
  processEnv: Record<string, string>;
  threadStorageDir: string;
  writableRoots: string[];
  callTool(args: {
    callId: string;
    tool: string;
    arguments: unknown;
    turnId: string | null;
  }): Promise<ToolCallResponse>;
  requestInteraction(args: {
    payload: PendingInteractionPayload;
    turnId: string | null;
  }): Promise<PendingInteractionResolution>;
  onExit(info: { message: string; stderrTail: string }): void;
}

const TITLE_MAX_LENGTH = 160;

function sliceHead(value: string, maxChars: number) {
  const code = value.charCodeAt(maxChars - 1);
  const splitsPair = code >= 0xd800 && code <= 0xdbff;
  return value.slice(0, splitsPair ? maxChars - 1 : maxChars);
}

function ellipsize(text: string, maxLength: number) {
  const fits = text.length <= maxLength;
  return fits ? text : `${sliceHead(text, maxLength - 1)}…`;
}

export function presentationTitle(text: string) {
  const firstLine = text.trim().split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) return undefined;
  return ellipsize(firstLine, TITLE_MAX_LENGTH);
}

export function presentationDetail(text: string) {
  return ellipsize(text, THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH);
}

export function presentationFileName(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

export function presentation(
  pending: string,
  completed: string,
  glyph: string,
  title?: string,
): Presentation {
  const base = { label: { pending, completed }, icon: { glyph } };
  const trimmed = title === undefined ? undefined : presentationTitle(title);
  return trimmed === undefined ? base : { ...base, title: trimmed };
}

export const AGENT_MESSAGE_PRESENTATION = presentation(
  "Responding",
  "Responded",
  "MessageSquare",
);
export const REASONING_PRESENTATION = presentation(
  "Thinking",
  "Thought",
  "Brain",
);
export const PLAN_PRESENTATION = presentation(
  "Writing plan",
  "Wrote plan",
  "ListTodo",
);
export const COMPACTION_PRESENTATION = presentation(
  "Compacting context",
  "Compacted context",
  "Archive",
);

const SHELL_WRAPPER = /^(?:\S*\/)?(?:sh|bash|zsh)\s+(?:-lc|-c)\s+([\s\S]+)$/;

function unwrapShellCommand(command: string) {
  const trimmed = command.trim();
  const inner = SHELL_WRAPPER.exec(trimmed)?.[1]?.trim();
  if (!inner) return trimmed;
  const quote = inner[0];
  const quoted =
    inner.length >= 2 &&
    (quote === '"' || quote === "'") &&
    inner.endsWith(quote);
  return quoted ? inner.slice(1, -1) : inner;
}

export function commandPresentation(command: string) {
  const title = unwrapShellCommand(command);
  return presentation("Running command", "Ran command", "Terminal", title);
}

export function fileChangePresentation(paths: readonly string[]) {
  const names = [...new Set(paths.map(presentationFileName))];
  const noun = names.length > 1 ? "files" : "file";
  const title = names.length === 0 ? undefined : names.join(", ");
  return presentation(`Editing ${noun}`, `Edited ${noun}`, "EditFile", title);
}

export function fileReadPresentation(path: string) {
  const title = presentationFileName(path);
  return presentation("Reading file", "Read file", "FileText", title);
}

export function searchPresentation(mode: "content" | "path", query: string) {
  return mode === "content"
    ? presentation("Searching files", "Searched files", "Search", query)
    : presentation("Finding files", "Found files", "FolderOpen", query);
}

export function webSearchPresentation(query: string | undefined) {
  return presentation("Searching the web", "Searched the web", "Globe", query);
}

export function webFetchPresentation(url: string) {
  return presentation("Fetching page", "Fetched page", "Browser", url);
}

export function imageViewPresentation(path: string) {
  const title = presentationFileName(path);
  return presentation("Viewing image", "Viewed image", "Eye", title);
}

export function planStepsPresentation(headline: string | undefined) {
  return presentation("Updating plan", "Updated plan", "ListTodo", headline);
}

export function toolPresentation(tool: string, title?: string) {
  return presentation(`Running ${tool}`, `Ran ${tool}`, "Toolbox", title);
}

export function agentPresentation(title: string) {
  return presentation("Running agent", "Agent finished", "UserRound", title);
}

function comparableLines(text: string) {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

const MAX_LINE_DIFF_CELLS = 1_000_000;

function changedLines(before: string[], after: string[]) {
  let start = 0;
  while (start < before.length && before[start] === after[start]) start += 1;
  let end = 0;
  while (
    end < Math.min(before.length, after.length) - start &&
    before.at(-1 - end) === after.at(-1 - end)
  ) {
    end += 1;
  }
  const a = before.slice(start, before.length - end);
  const b = after.slice(start, after.length - end);
  const width = b.length + 1;
  if ((a.length + 1) * width > MAX_LINE_DIFF_CELLS) {
    return [...a.map((line) => `-${line}`), ...b.map((line) => `+${line}`)];
  }
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const output: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (
      j >= b.length ||
      (i < a.length && lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])
    ) {
      output.push(`-${a[i]}`);
      i += 1;
    } else {
      output.push(`+${b[j]}`);
      j += 1;
    }
  }
  return output;
}

export function buildEditDiff(
  filePath: string,
  oldText: string | undefined,
  newText: string | undefined,
): string | undefined {
  if (oldText === undefined && newText === undefined) return undefined;
  const path = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const body = changedLines(
    oldText === undefined ? [] : comparableLines(oldText),
    newText === undefined ? [] : comparableLines(newText),
  );
  const edit = oldText !== undefined && newText !== undefined;
  if (edit && body.length === 0) return undefined;
  const from = oldText === undefined ? "--- /dev/null" : `--- a/${path}`;
  const to = newText === undefined ? "+++ /dev/null" : `+++ b/${path}`;
  return `${[from, to, ...body].join("\n")}\n`;
}

export const ZERO_TOKEN_USAGE: TokenUsage = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

export function addTokenUsage(total: TokenUsage, last: TokenUsage): TokenUsage {
  const sumOptional = (a: number | undefined, b: number | undefined) =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  const cacheRead = sumOptional(
    total.cacheReadInputTokens,
    last.cacheReadInputTokens,
  );
  const cacheWrite = sumOptional(
    total.cacheWriteInputTokens,
    last.cacheWriteInputTokens,
  );
  return {
    totalTokens: total.totalTokens + last.totalTokens,
    inputTokens: total.inputTokens + last.inputTokens,
    cachedInputTokens: total.cachedInputTokens + last.cachedInputTokens,
    ...(cacheRead === undefined ? {} : { cacheReadInputTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteInputTokens: cacheWrite }),
    outputTokens: total.outputTokens + last.outputTokens,
    reasoningOutputTokens:
      total.reasoningOutputTokens + last.reasoningOutputTokens,
  };
}
