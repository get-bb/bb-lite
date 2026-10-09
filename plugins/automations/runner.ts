import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginRunnerApi } from "@bb/runner";
import { automations, type ScriptResult } from "./contract.js";

const OUTPUT_MAX_BYTES = 1024 * 1024;

function kill(child: ChildProcess): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, "SIGKILL");
      return;
    }
  } catch {
    child.kill("SIGKILL");
    return;
  }
  child.kill("SIGKILL");
}

export function runScript(
  args: {
    command: string;
    path: string;
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
  },
  signal: AbortSignal,
): Promise<ScriptResult> {
  return new Promise((resolve) => {
    let output = "";
    let stderr = "";
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    const child = spawn(args.command, [args.path], {
      cwd: args.cwd,
      env: { ...process.env, ...args.env },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const take = (chunk: Buffer, into: "output" | "stderr") => {
      const room = OUTPUT_MAX_BYTES - bytes;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const text = chunk.subarray(0, room).toString("utf8");
      bytes += Math.min(chunk.length, room);
      if (chunk.length > room) truncated = true;
      if (into === "output") output += text;
      else stderr += text;
    };
    child.stdout.on("data", (chunk: Buffer) => take(chunk, "output"));
    child.stderr.on("data", (chunk: Buffer) => take(chunk, "stderr"));
    const timer = setTimeout(() => {
      timedOut = true;
      kill(child);
    }, args.timeoutMs);
    const abort = () => kill(child);
    signal.addEventListener("abort", abort);
    const done = (exitCode: number | null) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve({
        exitCode: timedOut ? null : exitCode,
        output: truncated ? `${output}\n[output truncated]\n` : output,
        stderr,
        timedOut,
      });
    };
    child.on("error", (error) => {
      stderr += error.message;
      done(127);
    });
    child.on("close", (code) => done(code));
  });
}

const EXTENSIONS = { bash: "sh", sh: "sh", node: "mjs", python3: "py" };

export default function automationsRunner(bb: PluginRunnerApi): void {
  bb.implement(automations.runScript, async (input, { signal }) => {
    const root = join(bb.dataDir, "scripts");
    const temp = join(bb.dataDir, "tmp");
    mkdirSync(root, { recursive: true });
    mkdirSync(temp, { recursive: true });
    const path = join(temp, `${randomUUID()}.${EXTENSIONS[input.interpreter]}`);
    writeFileSync(path, input.script, { mode: 0o700 });
    try {
      return await runScript(
        {
          command: input.interpreter,
          path,
          cwd: input.cwd ?? root,
          env: input.env,
          timeoutMs: input.timeoutMs,
        },
        signal,
      );
    } finally {
      rmSync(path, { force: true });
    }
  });
}
