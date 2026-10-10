import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { PluginRunnerApi } from "@bb/runner";
import { github } from "./contract.js";

export type Exec = (
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
) => Promise<string>;

const GH_CANDIDATES = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"];

function resolve(command: "gh" | "git"): string {
  if (command === "git") return "git";
  return GH_CANDIDATES.find((path) => existsSync(path)) ?? "gh";
}

const execProcess: Exec = (command, args, { cwd, timeoutMs }) =>
  new Promise((done, fail) => {
    execFile(
      command,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) return done(stdout);
        const missing = "code" in error && error.code === "ENOENT";
        fail(
          new Error(
            missing ? `${command} not found` : stderr.trim() || error.message,
          ),
        );
      },
    );
  });

export function createGithubRunner(exec: Exec) {
  return (bb: PluginRunnerApi): void => {
    bb.implement(github.exec, async ({ command, args, cwd, timeoutMs }) => ({
      stdout: await exec(resolve(command), args, {
        cwd,
        timeoutMs: timeoutMs ?? 30_000,
      }),
    }));
  };
}

export default function githubRunner(bb: PluginRunnerApi): void {
  createGithubRunner(execProcess)(bb);
}
