import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scrubbedProcessEnv } from "../../src/terminals/shell-env.js";
import { RunnerError, type RunnerErrorCode } from "../../src/types.js";
import {
  createWorkspaceApi,
  type WorkspaceHandle,
} from "../../src/workspace/index.js";
import type {
  WorkspaceApi,
  WorkspaceEvent,
} from "../../src/workspace-types.js";

const GIT_ENV = {
  ...scrubbedProcessEnv(),
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

export interface Harness {
  root: string;
  dataDir: string;
  api: WorkspaceApi;
  handle: WorkspaceHandle;
  events: WorkspaceEvent[];
  git(cwd: string, ...args: string[]): string;
  write(target: string, content: string | Buffer): void;
  initRepo(name: string, files: Record<string, string | Buffer>): string;
  waitFor<T>(probe: () => T | undefined | false, label: string): Promise<T>;
  dispose(): Promise<void>;
}

export function createHarness(): Harness {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "bb-runner-")),
  );
  const dataDir = path.join(root, "data");
  const events: WorkspaceEvent[] = [];
  const handle = createWorkspaceApi({
    dataDir,
    sink: (event) => events.push(event),
    env: async () => GIT_ENV,
  });
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  const write = (target: string, content: string | Buffer): void => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  return {
    root,
    dataDir,
    api: handle.api,
    handle,
    events,
    git,
    write,
    initRepo(name, files) {
      const repo = path.join(root, name);
      fs.mkdirSync(repo, { recursive: true });
      git(repo, "init", "--quiet", "-b", "main");
      for (const [file, content] of Object.entries(files)) {
        write(path.join(repo, file), content);
      }
      git(repo, "add", "-A");
      git(repo, "commit", "--quiet", "-m", "initial");
      return repo;
    },
    async waitFor(probe, label) {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const value = probe();
        if (value !== undefined && value !== false) {
          return value;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Timed out waiting for ${label}`);
    },
    async dispose() {
      await handle.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function failureCode(
  work: Promise<unknown>,
): Promise<RunnerErrorCode | "resolved"> {
  return work.then(
    () => "resolved",
    (error: unknown) => {
      if (error instanceof RunnerError) {
        return error.code;
      }
      throw error;
    },
  );
}

export function lines(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i}\n`).join("");
}
