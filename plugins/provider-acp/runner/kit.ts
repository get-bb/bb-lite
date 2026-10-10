import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { extname, isAbsolute, relative, sep } from "node:path";
import { promisify } from "node:util";
import {
  toolCallResponseSchema,
  type ThreadEventItemPresentation,
} from "@bb/domain";
import { labels, presentationTitle as runnerTitle } from "@bb/runner";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const CLI_PROBE_TIMEOUT_MS = 5_000;

export type DeltaPresentation = ThreadEventItemPresentation;

export type JsonRpcObject = Record<string, unknown>;

export interface JsonRpcMessage extends JsonRpcObject {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
}

export type ProviderRuntimeEvent = JsonRpcObject;

export interface StringRecord {
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is StringRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getStringProperty(
  value: StringRecord,
  key: string,
): string | undefined {
  const next = value[key];
  return typeof next === "string" ? next : undefined;
}

export function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export const presentationTitle = runnerTitle;

export const COMPACTION_PRESENTATION: DeltaPresentation = labels.compaction;

export function planStepsPresentation(
  steps: readonly { step: string; status?: string }[],
): DeltaPresentation {
  const active = steps.find((step) => step.status === "active");
  return { ...labels.planSteps(active?.step), suppress: true };
}

const contentWrapperSchema = z
  .object({ content: z.array(z.unknown()) })
  .passthrough();
const textBlockSchema = z.object({ type: z.literal("text"), text: z.string() });

function describeToolReferences(blocks: unknown[]): string | null {
  const names: string[] = [];
  for (const block of blocks) {
    if (!isRecord(block) || block.type !== "tool_reference") return null;
    const name = getStringProperty(block, "tool_name");
    if (!name) return null;
    names.push(name);
  }
  return names.length === 0 ? null : `Loaded tools: ${names.join(", ")}`;
}

function describeContentBlock(block: unknown): string | null {
  if (!isRecord(block)) return null;
  const type = getStringProperty(block, "type");
  if (!type) return null;
  const path = getStringProperty(block, "path");
  const tool = getStringProperty(block, "tool_name");
  const url =
    getStringProperty(block, "url") ?? getStringProperty(block, "imageUrl");
  const detail = path ?? tool ?? url;
  return detail ? `[${type}: ${detail}]` : `[${type}]`;
}

export function extractResultText(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") {
    return JSON.stringify(content);
  }
  if (!Array.isArray(content)) {
    const wrapper = contentWrapperSchema.safeParse(content);
    if (wrapper.success) return extractResultText(wrapper.data.content);
    return JSON.stringify(content);
  }
  const references = describeToolReferences(content);
  if (references) return references;
  const chunks: string[] = [];
  for (const block of content) {
    const parsed = textBlockSchema.safeParse(block);
    const text = parsed.success
      ? parsed.data.text
      : describeContentBlock(block);
    if (text) chunks.push(text);
  }
  return chunks.join("\n");
}

export type ProviderRawEventCoverage = "normalized" | "noise" | "unknown";

export interface ProviderRawEventDescription {
  kind: string;
  coverage: ProviderRawEventCoverage;
}

export interface ProviderVisibilityMetadata<
  TRawEvent extends { kind: string } = { kind: string },
> {
  parseRawEvent(event: JsonRpcMessage): TRawEvent;
  describeParsedRawEvent(event: TRawEvent): ProviderRawEventDescription;
  describeRawEvent(event: JsonRpcMessage): ProviderRawEventDescription;
}

export function createProviderVisibilityMetadata<
  TRawEvent extends { kind: string },
>(args: {
  parseRawEvent(event: JsonRpcMessage): TRawEvent;
  describeParsedRawEvent(event: TRawEvent): ProviderRawEventDescription;
}): ProviderVisibilityMetadata<TRawEvent> {
  return {
    parseRawEvent: args.parseRawEvent,
    describeParsedRawEvent: args.describeParsedRawEvent,
    describeRawEvent(event) {
      return args.describeParsedRawEvent(args.parseRawEvent(event));
    },
  };
}

const recordSchema = z.record(z.string(), z.unknown());

export const jsonRpcEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.string(),
    params: recordSchema.optional(),
  })
  .passthrough();

export const errorEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.literal("error"),
    params: z
      .object({ message: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface BridgeToolCallImage {
  data: string;
  mimeType: string;
}

export type BridgeToolCallContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const IMAGE_DATA_URL = /^data:(.+);base64,(.+)$/s;

export function decodeToolCallResponsePayload(result: unknown): {
  content: string;
  contentBlocks: BridgeToolCallContent[];
  images: BridgeToolCallImage[];
  isError: boolean;
} {
  const parsed = toolCallResponseSchema.safeParse(result);
  if (!parsed.success) {
    const text = "Invalid tool call response";
    const contentBlocks: BridgeToolCallContent[] = [{ type: "text", text }];
    return { content: text, contentBlocks, images: [], isError: true };
  }
  const texts: string[] = [];
  const contentBlocks: BridgeToolCallContent[] = [];
  const images: BridgeToolCallImage[] = [];
  for (const item of parsed.data.contentItems) {
    if (item.type === "inputText") {
      texts.push(item.text);
      if (item.text !== "")
        contentBlocks.push({ type: "text", text: item.text });
      continue;
    }
    const match = IMAGE_DATA_URL.exec(item.imageUrl);
    if (match === null || match[2].length === 0) {
      texts.push(item.imageUrl);
      contentBlocks.push({ type: "text", text: item.imageUrl });
      continue;
    }
    const image = { mimeType: match[1], data: match[2] };
    images.push(image);
    contentBlocks.push({ type: "image", ...image });
  }
  const isError = !parsed.data.success;
  if (contentBlocks.length === 0) {
    const text = isError ? "Tool call failed" : "OK";
    return {
      content: text,
      contentBlocks: [{ type: "text", text }],
      images,
      isError,
    };
  }
  return { content: texts.join("\n"), contentBlocks, images, isError };
}

export function mimeTypeFromExtension(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "image/png";
  }
}

export function clampPercent(value: number): number {
  return Math.min(
    100,
    Math.max(0, Math.round(Number.isFinite(value) ? value : 0)),
  );
}

export function isPathWithinDirectory(
  directoryPath: string,
  candidatePath: string,
): boolean {
  const relativePath = relative(directoryPath, candidatePath);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

export async function resolveExecutablePath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (isAbsolute(command)) {
    return access(command, fsConstants.X_OK).then(
      () => command,
      () => null,
    );
  }
  const lookup = process.platform === "win32" ? "where" : "which";
  const options = { timeout: CLI_PROBE_TIMEOUT_MS, env };
  try {
    const { stdout } = await execFileAsync(lookup, [command], options);
    return stdout.split(/\r?\n/u).find((line) => line.trim() !== "") ?? null;
  } catch {
    return null;
  }
}

export function versionFrom(value: string | null): string | null {
  return value?.match(/\bv?(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/u)?.[1] ?? null;
}

export async function readCliVersion(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, ["--version"], {
      timeout: CLI_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env,
    });
    return versionFrom(`${stdout}\n${stderr}`);
  } catch {
    return null;
  }
}

export interface ExecFileOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  timeout?: number;
}

export async function execPortableFile(
  command: string,
  args: string[],
  options: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(command, args, options);
  return { stdout, stderr };
}

export interface ProcessStopResult {
  treeTermination: "confirmed" | "unverified";
}

export interface ManagedProcess {
  child: ChildProcess;
  stop(options?: { gracePeriodMs: number }): Promise<ProcessStopResult>;
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export function spawnManagedProcess(request: {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): ManagedProcess {
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let stopping: Promise<ProcessStopResult> | undefined;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const stop: ManagedProcess["stop"] = (
    { gracePeriodMs } = { gracePeriodMs: 1_000 },
  ) => {
    stopping ??= new Promise<ProcessStopResult>((resolve) => {
      const done = () => resolve({ treeTermination: "confirmed" });
      if (child.pid === undefined || exited()) {
        signalTree(child, "SIGKILL");
        return done();
      }
      child.once("exit", () => {
        clearTimeout(timer);
        signalTree(child, "SIGKILL");
        done();
      });
      const timer = setTimeout(
        () => signalTree(child, "SIGKILL"),
        gracePeriodMs,
      );
      timer.unref();
      signalTree(child, "SIGTERM");
    });
    return stopping;
  };
  return { child, stop };
}

export function isClosedProcessStdinError(error: Error): boolean {
  return (
    "code" in error &&
    (error.code === "EPIPE" ||
      error.code === "EOF" ||
      error.code === "ERR_STREAM_DESTROYED")
  );
}

export function agentProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env };
  delete child.ELECTRON_RUN_AS_NODE;
  return child;
}

export function buildBridgeToolCallContent(result: {
  content: string;
  contentBlocks?: BridgeToolCallContent[];
  images?: BridgeToolCallImage[];
}): BridgeToolCallContent[] {
  if (result.contentBlocks !== undefined) return result.contentBlocks;
  const blocks: BridgeToolCallContent[] = [];
  if (result.content !== "")
    blocks.push({ type: "text", text: result.content });
  for (const { data, mimeType } of result.images ?? []) {
    blocks.push({ type: "image", data, mimeType });
  }
  return blocks;
}

export interface ProviderInstallationCommand {
  command: string;
  args: string[];
  displayCommand: string;
}

export function downloadedInstallerCommand(
  url: string,
  options: { platform?: NodeJS.Platform; powershellUrl?: string } = {},
): ProviderInstallationCommand {
  const windows = (options.platform ?? process.platform) === "win32";
  if (windows && options.powershellUrl !== undefined) {
    const script = `irm ${options.powershellUrl} | iex`;
    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ];
    return { command: "powershell.exe", args, displayCommand: script };
  }
  const script = [
    'tmp=$(mktemp "${TMPDIR:-/tmp}/provider-installation.XXXXXX")',
    "trap 'rm -f \"$tmp\"' EXIT",
    `curl -fsSL ${url} -o "$tmp"`,
    'bash "$tmp"',
  ].join(" && ");
  return { command: "sh", args: ["-c", script], displayCommand: script };
}
