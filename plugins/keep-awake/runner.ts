import { spawn } from "node:child_process";
import type { PluginRunnerApi } from "@bb/runner";
import { keepAwake } from "./contract.js";

const RESTART_DELAY_MS = 1_000;
const MAX_RESTART_DELAY_MS = 60_000;
const SETTLED_CHILD_MS = 10_000;
const WINDOWS_AWAKE_STATE = 0x80000001;

export interface KeepAwakeChild {
  kill(signal: NodeJS.Signals): boolean;
  once(event: "error" | "exit", listener: () => void): unknown;
}

export interface KeepAwakeMachine {
  pid: number;
  platform: NodeJS.Platform;
  now(): number;
  spawn(command: string, args: string[]): KeepAwakeChild;
}

export function keepAwakeCommand(platform: NodeJS.Platform, pid: number) {
  if (platform === "darwin") {
    return { command: "/usr/bin/caffeinate", args: ["-i", "-w", String(pid)] };
  }
  if (platform !== "win32") return null;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$power = Add-Type -Name KeepAwake -Namespace Bb -PassThru -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);'",
    `if ($power::SetThreadExecutionState(${WINDOWS_AWAKE_STATE}) -eq 0) { exit 1 }`,
    `Wait-Process -Id ${pid}`,
  ];
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", script.join("; ")],
  };
}

export function createKeepAwakeRunner(machine: KeepAwakeMachine) {
  return (bb: PluginRunnerApi): void => {
    const command = keepAwakeCommand(machine.platform, machine.pid);
    let wanted = false;
    let child: KeepAwakeChild | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delayMs = RESTART_DELAY_MS;

    const stop = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const active = child;
      child = null;
      active?.kill("SIGTERM");
    };

    const restartLater = () => {
      if (timer !== null || !wanted) return;
      bb.signal("exited", { restartInMs: delayMs });
      timer = setTimeout(() => {
        timer = null;
        start();
      }, delayMs);
      delayMs = Math.min(delayMs * 2, MAX_RESTART_DELAY_MS);
    };

    const start = () => {
      if (child !== null || timer !== null || !wanted || command === null) {
        return;
      }
      let next: KeepAwakeChild;
      try {
        next = machine.spawn(command.command, command.args);
      } catch {
        restartLater();
        return;
      }
      child = next;
      const startedAt = machine.now();
      const exited = () => {
        if (child !== next) return;
        child = null;
        if (machine.now() - startedAt >= SETTLED_CHILD_MS) {
          delayMs = RESTART_DELAY_MS;
        }
        restartLater();
      };
      next.once("error", exited);
      next.once("exit", exited);
    };

    bb.implement(keepAwake.updateMachine, ({ enabled }) => {
      wanted = command !== null && enabled;
      if (wanted) start();
      else {
        delayMs = RESTART_DELAY_MS;
        stop();
      }
      return { enabled: child !== null, supported: command !== null };
    });
    bb.onDispose(() => {
      wanted = false;
      stop();
    });
  };
}

export default function keepAwakeRunner(bb: PluginRunnerApi): void {
  createKeepAwakeRunner({
    pid: process.pid,
    platform: process.platform,
    now: Date.now,
    spawn: (command, args) => spawn(command, args, { stdio: "ignore" }),
  })(bb);
}
