import type {
  PendingInteractionPayload,
  PendingInteractionResolution,
  PromptInput,
  ThreadEventItemPresentation as Presentation,
  ThreadEventTokenUsageBreakdown as TokenUsage,
  ToolCallResponse,
} from "@bb/domain";
import type { EventBuilder } from "../events/event-builder.js";
import type {
  ExecutionOptions as Options,
  ProviderId,
  ProviderModels,
  ProviderStatus,
  SessionSpec,
} from "../types.js";

type Opening = Promise<ProviderSession>;

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly approvalEnforcedBy: "runner" | "provider";
  status(): Promise<ProviderStatus>;
  listModels(cwd: string | null): Promise<ProviderModels>;
  open(spec: SessionSpec, options: Options, host: SessionHost): Opening;
}

export interface TurnInput {
  clientRequestId: string;
  input: PromptInput[];
  options: Options;
}
export type SteerInput = TurnInput & { expectedTurnId: string };

export interface ProviderSession {
  readonly providerThreadId: string;
  canApply(spec: SessionSpec, options: Options): boolean;
  startTurn(args: TurnInput): Promise<void>;
  steer(args: SteerInput): Promise<"steered" | "stale">;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  rename?(title: string): Promise<void>;
}

export interface ToolCall {
  callId: string;
  tool: string;
  arguments: unknown;
  turnId: string | null;
}
export interface Interaction {
  payload: PendingInteractionPayload;
  turnId: string | null;
}

export interface SessionHost {
  events: EventBuilder;
  env: Record<string, string>;
  processEnv: Record<string, string>;
  threadStorageDir: string;
  writableRoots: string[];
  callTool(args: ToolCall): Promise<ToolCallResponse>;
  requestInteraction(args: Interaction): Promise<PendingInteractionResolution>;
  onExit(info: { message: string; stderrTail: string }): void;
}

const TITLE_MAX_LENGTH = 160;
const SHELL_WRAPPER = /^(?:\S*\/)?(?:sh|bash|zsh)\s+(?:-lc|-c)\s+([\s\S]+)$/;

export function ellipsize(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  const code = text.charCodeAt(maxLength - 2);
  const splitsPair = code >= 0xd800 && code <= 0xdbff;
  return `${text.slice(0, maxLength - (splitsPair ? 2 : 1))}…`;
}

export function presentationTitle(text: string) {
  const firstLine = text.trim().split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) return undefined;
  return ellipsize(firstLine, TITLE_MAX_LENGTH);
}

export function fileName(path: string) {
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

function unwrapShellCommand(command: string) {
  const trimmed = command.trim();
  const inner = SHELL_WRAPPER.exec(trimmed)?.[1]?.trim();
  if (!inner) return trimmed;
  const quoted = /^(["']).*\1$/s.test(inner) && inner.length >= 2;
  return quoted ? inner.slice(1, -1) : inner;
}

const label = presentation;

export const labels = {
  message: label("Responding", "Responded", "MessageSquare"),
  reasoning: label("Thinking", "Thought", "Brain"),
  plan: label("Writing plan", "Wrote plan", "ListTodo"),
  compaction: label("Compacting context", "Compacted context", "Archive"),
  command(command: string) {
    const title = unwrapShellCommand(command);
    return label("Running command", "Ran command", "Terminal", title);
  },
  fileChange(paths: readonly string[]) {
    const names = [...new Set(paths.map(fileName))];
    const noun = names.length > 1 ? "files" : "file";
    const title = names.length === 0 ? undefined : names.join(", ");
    return label(`Editing ${noun}`, `Edited ${noun}`, "EditFile", title);
  },
  fileRead: (path: string) =>
    label("Reading file", "Read file", "FileText", fileName(path)),
  search: (mode: "content" | "path", query: string) =>
    mode === "content"
      ? label("Searching files", "Searched files", "Search", query)
      : label("Finding files", "Found files", "FolderOpen", query),
  webSearch: (query?: string) =>
    label("Searching the web", "Searched the web", "Globe", query),
  webFetch: (url: string) =>
    label("Fetching page", "Fetched page", "Browser", url),
  imageView: (path: string) =>
    label("Viewing image", "Viewed image", "Eye", fileName(path)),
  planSteps: (headline?: string) =>
    label("Updating plan", "Updated plan", "ListTodo", headline),
  tool: (tool: string, title?: string) =>
    label(`Running ${tool}`, `Ran ${tool}`, "Toolbox", title),
  agent: (title: string) =>
    label("Running agent", "Agent finished", "UserRound", title),
};

function comparableLines(text: string | undefined) {
  if (text === undefined) return [];
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

const MAX_LINE_DIFF_CELLS = 1_000_000;

function changedLines(before: string[], after: string[]) {
  let start = 0;
  while (start < before.length && before[start] === after[start]) start += 1;
  let end = 0;
  const shorter = Math.min(before.length, after.length) - start;
  while (end < shorter && before.at(-1 - end) === after.at(-1 - end)) end += 1;
  const a = before.slice(start, before.length - end);
  const b = after.slice(start, after.length - end);
  const width = b.length + 1;
  if ((a.length + 1) * width > MAX_LINE_DIFF_CELLS) {
    return [...a.map((line) => `-${line}`), ...b.map((line) => `+${line}`)];
  }
  const lcs = new Uint32Array((a.length + 1) * width);
  const at = (i: number, j: number) => lcs[i * width + j];
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const longest = Math.max(at(i + 1, j), at(i, j + 1));
      lcs[i * width + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : longest;
    }
  }
  const output: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const removes = i < a.length && at(i + 1, j) >= at(i, j + 1);
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (j >= b.length || removes) {
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
  oldText?: string,
  newText?: string,
) {
  if (oldText === undefined && newText === undefined) return undefined;
  const path = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const body = changedLines(comparableLines(oldText), comparableLines(newText));
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
  const sum = { ...total };
  for (const key of Object.keys(last) as (keyof TokenUsage)[]) {
    sum[key] = (total[key] ?? 0) + (last[key] ?? 0);
  }
  return sum;
}
