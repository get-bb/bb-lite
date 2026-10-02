import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createTerminalOutputLineReader,
  DEFAULT_ENV_SETUP_SCRIPT_NAME,
  DEFAULT_ENV_TEARDOWN_SCRIPT_NAME,
} from "@bb/domain";
import type {
  LifecycleScriptResult,
  WorkspaceApi,
} from "../workspace-types.js";
import { fail, pathExists, requireAbsolute, type Ctx } from "./exec.js";

const REMEMBERED_OPERATIONS = 256;
const MAX_TIMER_MS = 2 ** 31 - 1;
const OUTPUT_DRAIN_MS = 250;
const OUTPUT_EVENT_MAX_LENGTH = 64 * 1024;
const GROUP_EXIT_POLL_MS = 25;
const GROUP_EXIT_POLLS = 200;
const OUTPUT = { lane: "reliable", kind: "script.output" } as const;

type ScriptArgs = Parameters<WorkspaceApi["runLifecycleScript"]>[0];
type FailureReason = NonNullable<LifecycleScriptResult["failure"]>["reason"];
type Exit = { code: number | null; signal: NodeJS.Signals | null };

interface Operation {
  controller: AbortController;
  done: Promise<LifecycleScriptResult>;
  settled: boolean;
}

export interface LifecycleScripts {
  run: WorkspaceApi["runLifecycleScript"];
  cancel: WorkspaceApi["cancelOperation"];
  dispose(): Promise<void>;
}

function signalGroup(pid: number | undefined, signal: "SIGKILL" | 0) {
  try {
    return pid !== undefined && process.kill(-pid, signal);
  } catch {
    return false;
  }
}

function failed(
  reason: FailureReason,
  message: string,
  exitCode: number | null = null,
) {
  return { ran: true, exitCode, failure: { reason, message } };
}

async function runScript(ctx: Ctx, args: ScriptArgs, signal: AbortSignal) {
  const setup = args.kind === "setup";
  const scriptName = setup
    ? DEFAULT_ENV_SETUP_SCRIPT_NAME
    : DEFAULT_ENV_TEARDOWN_SCRIPT_NAME;
  const scriptPath = path.join(requireAbsolute(args.path), scriptName);
  if (!(await pathExists(scriptPath))) {
    return { ran: false, exitCode: null, failure: null };
  }
  if (process.platform === "win32") {
    fail("unavailable", `${scriptName} needs a POSIX shell`);
  }
  const child = spawn("env", ["bash", scriptPath], {
    cwd: args.path,
    detached: true,
    env: { ...(await ctx.env()), ...args.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let timedOut = false;
  const killGroup = (): boolean => signalGroup(child.pid, "SIGKILL");
  const expire = () => {
    timedOut = true;
    killGroup();
  };
  const timer = setTimeout(expire, Math.min(args.timeoutMs, MAX_TIMER_MS));
  signal.addEventListener("abort", killGroup, { once: true });
  if (signal.aborted) killGroup();
  const flushes = [child.stdout, child.stderr].map((stream) => {
    const reader = createTerminalOutputLineReader();
    const emit = (lines: string[]) => {
      const output = lines.map((line) => `${line}\n`).join("");
      const { operationId } = args;
      for (let at = 0; at < output.length; at += OUTPUT_EVENT_MAX_LENGTH) {
        const text = output.slice(at, at + OUTPUT_EVENT_MAX_LENGTH);
        ctx.sink({ ...OUTPUT, operationId, text });
      }
    };
    stream.setEncoding("utf8");
    stream.on("data", (text: string) => emit(reader.push(text)));
    return () => emit(reader.flush());
  });
  try {
    const exit = await new Promise<Exit>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, by) => resolve({ code, signal: by }));
    });
    const closed = new Promise((resolve) => child.once("close", resolve));
    await Promise.race([closed, delay(OUTPUT_DRAIN_MS)]);
    const killed = timedOut || signal.aborted;
    for (let poll = 0; killed && poll < GROUP_EXIT_POLLS; poll += 1) {
      if (!signalGroup(child.pid, 0)) break;
      await delay(GROUP_EXIT_POLL_MS);
    }
    flushes.forEach((flush) => flush());
    const label = `${setup ? "Setup" : "Teardown"} script`;
    const report = (reason: FailureReason, how: string, code?: number) =>
      failed(reason, `${label} ${how}: ${scriptPath}`, code);
    if (signal.aborted) return failed("cancelled", `${scriptName} cancelled`);
    if (timedOut)
      return report("timeout", `timed out after ${args.timeoutMs}ms`);
    const by = exit.signal;
    if (by !== null) return report("signal", `exited via signal ${by}`);
    const code = exit.code ?? 1;
    if (code !== 0)
      return report("exit", `failed with exit code ${code}`, code);
    return { ran: true, exitCode: 0, failure: null };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", killGroup);
  }
}

export function createLifecycleScripts(ctx: Ctx): LifecycleScripts {
  const operations = new Map<string, Operation | "cancelled">();
  return {
    async run(args) {
      const existing = operations.get(args.operationId);
      if (existing === "cancelled") {
        const reason = "Operation was cancelled before it started";
        return { ...failed("cancelled", reason), ran: false };
      }
      if (existing !== undefined) return existing.done;
      const controller = new AbortController();
      const settle = () => {
        operation.settled = true;
      };
      const done = runScript(ctx, args, controller.signal).finally(settle);
      const operation = { controller, done, settled: false };
      operations.set(args.operationId, operation);
      if (operations.size > REMEMBERED_OPERATIONS) {
        operations.delete(operations.keys().next().value ?? "");
      }
      return done;
    },
    async cancel({ operationId }) {
      const operation = operations.get(operationId);
      if (operation === undefined || operation === "cancelled") {
        operations.set(operationId, "cancelled");
        return { cancelled: false };
      }
      const cancelled = !operation.settled;
      operation.controller.abort();
      await operation.done.catch(() => undefined);
      return { cancelled };
    },
    async dispose() {
      const running = [...operations.values()].filter(
        (operation) => operation !== "cancelled",
      );
      running.forEach((operation) => operation.controller.abort());
      await Promise.allSettled(running.map((operation) => operation.done));
    },
  };
}
