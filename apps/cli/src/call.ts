import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import type { OpClient } from "@bb/plugin";
import type { ZodType } from "zod";
import {
  CliError,
  usageError,
  type CommandSpec,
  type Invocation,
  type Table,
} from "./engine.js";

interface Modules {
  plugin: typeof import("@bb/plugin");
  domain: typeof import("@bb/domain");
}
type Unit = keyof typeof UNIT_MS;

export interface CliEnv {
  serverUrl: string;
  threadId?: string;
  projectId?: string;
  environmentId?: string;
  hostId?: string;
  threadStorage?: string;
}

export const DEFAULT_SERVER_URL = "http://127.0.0.1:48886";
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/u;
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/u;
const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/u;
const CELL_WIDTH = 60;

let modules: Modules | undefined;

export async function loadModules(): Promise<Modules> {
  modules ??= {
    plugin: await import("@bb/plugin"),
    domain: await import("@bb/domain"),
  };
  return modules;
}

export function loaded(): Modules {
  if (modules !== undefined) return modules;
  throw new Error("The bb client modules are not loaded");
}

export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === "ZodError") return "The server sent unexpected data.";
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}

export function validId(value: string, source: string): string {
  if (ID_PATTERN.test(value)) return value;
  throw usageError(
    `Invalid ID from ${source}: "${value}". IDs contain only letters, ` +
      "digits, hyphens and underscores.",
  );
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): CliEnv {
  const id = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? validId(value, name) : undefined;
  };
  const serverUrl = env.BB_SERVER_URL?.trim() || DEFAULT_SERVER_URL;
  return {
    serverUrl: serverUrl.replace(/\/+$/u, ""),
    threadId: id("BB_THREAD_ID"),
    projectId: id("BB_PROJECT_ID"),
    environmentId: id("BB_ENVIRONMENT_ID"),
    hostId: id("BB_HOST_ID"),
    threadStorage: env.BB_THREAD_STORAGE?.trim() || undefined,
  };
}

export function clip(value: string, width = CELL_WIDTH): string {
  const line = value.replace(/\s+/gu, " ").trim();
  return line.length <= width ? line : `${line.slice(0, width - 1)}…`;
}

export interface Remote {
  readonly ops: Modules["plugin"];
  readonly op: OpClient["call"];
  readonly request: OpClient["request"];
}

export class Call implements Remote {
  wroteJson = false;
  private client: OpClient | undefined;

  constructor(
    readonly table: Table,
    readonly spec: CommandSpec,
    private readonly invocation: Invocation,
    readonly env: CliEnv,
  ) {}

  get args(): Record<string, string | undefined> {
    return this.invocation.args;
  }

  get rest(): string[] {
    return this.invocation.rest;
  }

  get json(): boolean {
    return this.on("json");
  }

  arg(name: string): string {
    const value = this.invocation.args[name];
    if (value !== undefined) return value;
    throw new Error(`'bb ${this.spec.path}' has no required <${name}>`);
  }

  list(name: string): string[] {
    if (this.spec.flags.every((flag) => flag.names[0] !== name)) {
      throw new Error(`'bb ${this.spec.path}' does not declare --${name}`);
    }
    return this.invocation.flags.get(name) ?? [];
  }

  flag(name: string): string | undefined {
    return this.list(name).at(-1);
  }

  on(name: string): boolean {
    this.list(name);
    return this.invocation.flags.has(name);
  }

  id(name: string): string | undefined {
    const value = this.flag(name)?.trim();
    return value ? validId(value, `--${name}`) : undefined;
  }

  choice<const Values extends readonly string[]>(
    name: string,
    allowed: Values,
  ): Values[number] | undefined {
    const value = this.flag(name)?.trim().toLowerCase();
    if (value === undefined) return undefined;
    const match = allowed.find((candidate) => candidate === value);
    if (match !== undefined) return match;
    const expected = allowed.join(", ");
    throw usageError(`Invalid --${name} '${value}'. Expected: ${expected}.`);
  }

  get ops(): Modules["plugin"] {
    return loaded().plugin;
  }

  private get remote(): OpClient {
    const { createOpClient, DEFAULT_CALL_TIMEOUT_MS } = loaded().plugin;
    this.client ??= createOpClient({
      baseUrl: this.env.serverUrl,
      door: "cli",
      threadId: process.env.BB_THREAD_ID || undefined,
      timeoutMs: DEFAULT_CALL_TIMEOUT_MS,
    });
    return this.client;
  }

  readonly op: OpClient["call"] = (op, input, options) =>
    this.remote.call(op, input, options);

  readonly request: OpClient["request"] = (path, init) =>
    this.remote.request(path, init);

  out(data: unknown, text?: string | string[]): void {
    if (this.json || text === undefined) {
      console.log(JSON.stringify(data ?? { ok: true }, null, 2));
      this.wroteJson = true;
    } else {
      console.log(Array.isArray(text) ? text.join("\n") : text);
    }
  }

  rows<Row extends object>(
    rows: Row[],
    keys: (keyof Row & string)[],
    data: unknown = rows,
  ): void {
    const shown = (key: string, value: unknown): string =>
      key.endsWith("At") && typeof value === "number"
        ? new Date(value).toLocaleString()
        : clip(`${value ?? "-"}`);
    const cells = rows.map((row) => keys.map((key) => shown(key, row[key])));
    const widths = keys.map((key, column) =>
      Math.max(key.length, ...cells.map((row) => (row[column] ?? "").length)),
    );
    const line = (row: string[]): string =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd();
    const head = line(keys.map((key) => key.toUpperCase()));
    const lines = ["", head, ...cells.map(line), ""];
    this.out(data, rows.length === 0 ? "None found" : lines);
  }
}

export function threadTarget(call: Call): string {
  const { id } = call.args;
  const current = call.env.threadId;
  if (call.on("self")) {
    if (id !== undefined) {
      throw usageError("Cannot combine a thread ID argument with --self.");
    }
    if (current !== undefined) return current;
    throw usageError("--self requires BB_THREAD_ID to be set.");
  }
  if (id !== undefined) return validId(id, "<id> argument");
  throw new CliError("Missing thread ID. Pass <id> or use --self.", {
    code: "missing_required",
    hint: current && `Add --self to target the current thread (${current}).`,
  });
}

export async function confirm(call: Call, question: string): Promise<void> {
  if (call.on("yes")) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw usageError(
      "Refusing a destructive action without an interactive terminal.",
      "Re-run with --yes to confirm.",
    );
  }
  const { stdin: input, stdout: output } = process;
  const readline = createInterface({ input, output });
  const answer = await readline.question(`${question} [y/N] `);
  readline.close();
  if (["y", "yes"].includes(answer.trim().toLowerCase())) return;
  throw new CliError("Cancelled.", { code: "cancelled" });
}

export async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export async function textInput(
  call: Call,
  inline: string | undefined,
  fileFlag: string,
  inlineLabel: string,
): Promise<string> {
  const file = call.flag(fileFlag);
  if (file === undefined) {
    if (inline !== undefined) return inline;
    throw new CliError(`Missing ${inlineLabel}.`, {
      code: "missing_required",
      hint: `Pass ${inlineLabel}, or --${fileFlag} <path> (- reads stdin).`,
    });
  }
  if (inline !== undefined) {
    throw usageError(`Provide only one of ${inlineLabel} or --${fileFlag}.`);
  }
  if (file === "-" && process.stdin.isTTY) {
    throw usageError(`--${fileFlag} - reads stdin, but stdin is a terminal.`);
  }
  const raw =
    file === "-"
      ? (await readStdin()).toString("utf8")
      : await readFile(file, "utf8").catch((error: unknown) => {
          const reason = errorMessage(error);
          throw usageError(`Could not read --${fileFlag}: ${reason}`);
        });
  const text = raw.replace(/(\r?\n)+$/u, "");
  if (text.trim() !== "") return text;
  throw usageError(`--${fileFlag} ${file === "-" ? "stdin" : file} is empty.`);
}

function isUnit(value: string | undefined): value is Unit {
  return value !== undefined && Object.hasOwn(UNIT_MS, value);
}

export function durationMs(
  value: string,
  label: string,
  unit: Unit,
  allowZero = false,
): number {
  const [, amount, suffix] = DURATION.exec(value.trim().toLowerCase()) ?? [];
  if (amount === undefined) {
    throw usageError(
      `Invalid ${label} '${value}'. Expected a number of ${unit} or a ` +
        "duration with a unit (500ms, 90s, 20m, 4h).",
    );
  }
  const scale = UNIT_MS[isUnit(suffix) ? suffix : unit];
  const milliseconds = Math.round(Number.parseFloat(amount) * scale);
  if (milliseconds > 0 || allowZero) return milliseconds;
  throw usageError(`${label} must be greater than zero.`);
}

export function sendAtMs(value?: string, now = Date.now()): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const relative = /[a-z]$/iu.test(trimmed) && DURATION.test(trimmed);
  const at = relative
    ? now + durationMs(trimmed, "--send-at", "s")
    : TIMESTAMP.test(trimmed)
      ? Date.parse(trimmed.replace(" ", "T"))
      : Number.NaN;
  if (Number.isFinite(at) && at > now) return at;
  throw usageError(
    `Invalid --send-at '${value}'. Expected a future ISO 8601 timestamp ` +
      "(2026-08-25T09:00) or a duration from now (30s, 10m, 2h, 7d).",
  );
}

export function integer(
  value: string | undefined,
  label: string,
  minimum = 1,
): number | undefined {
  if (value === undefined) return undefined;
  if (/^\d+$/u.test(value) && Number(value) >= minimum) return Number(value);
  throw usageError(`${label} must be an integer of at least ${minimum}.`);
}

export function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw usageError(`${label} must be valid JSON.`);
  }
}

export function valid<Output>(
  schema: ZodType<Output>,
  value: unknown,
  label: string,
): Output {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
  throw usageError(`Invalid ${label}${where}: ${issue?.message}`);
}

export async function machineId(call: Call, target: string): Promise<string> {
  const wanted = target.trim();
  if (wanted.startsWith("host_")) return validId(wanted, "machine ID");
  const hosts = await call.op(call.ops.machines.list, {
    includeCreating: true,
  });
  const named = hosts.filter((host) => host.name === wanted);
  const [found] = named;
  if (found !== undefined && named.length === 1) return found.id;
  const all = hosts.map((host) => `${host.name} (${host.id})`).join(", ");
  const problem = found === undefined ? "was not found" : "is ambiguous";
  throw usageError(`Machine '${wanted}' ${problem}. Machines: ${all}.`);
}

export async function machineFlag(call: Call): Promise<string | undefined> {
  const machine = call.flag("machine");
  return machine === undefined ? undefined : machineId(call, machine);
}

export async function thisMachineId(call: Call): Promise<string> {
  const { environmentId } = call.env;
  if (environmentId !== undefined) {
    return (await call.op(call.ops.environments.get, { environmentId })).hostId;
  }
  const { primaryHostId } = await call.op(call.ops.server.config, {});
  if (primaryHostId !== null) return primaryHostId;
  throw usageError("The server has no machine of its own.", "Pass --machine.");
}

export async function machineOrThis(call: Call): Promise<string> {
  return (await machineFlag(call)) ?? (await thisMachineId(call));
}
