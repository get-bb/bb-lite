import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scrubbedProcessEnv } from "../../src/terminals/shell-env.js";
import { RunnerError } from "../../src/types.js";
import { createWorkspaceApi } from "../../src/workspace/index.js";
import type { WorkspaceEvent } from "../../src/workspace-types.js";

const GIT_ENV = {
  ...scrubbedProcessEnv(),
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

export type Harness = ReturnType<typeof createHarness>;
type Files = Record<string, string | Buffer>;

export function createHarness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bb-runner-"));
  const root = fs.realpathSync(tmp);
  const dataDir = path.join(root, "data");
  const events: WorkspaceEvent[] = [];
  const sink = (event: WorkspaceEvent): void => void events.push(event);
  const env = async (): Promise<NodeJS.ProcessEnv> => GIT_ENV;
  const handle = createWorkspaceApi({ dataDir, sink, env });
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
  const write = (directory: string, files: Files): void => {
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(directory, file), content);
    }
  };
  const commitAll = (repo: string, message: string): string => {
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", message);
    return git(repo, "rev-parse", "HEAD");
  };
  const initRepo = (name: string, files: Files): string => {
    const repo = path.join(root, name);
    write(repo, files);
    git(repo, "init", "--quiet", "-b", "main");
    commitAll(repo, "initial");
    return repo;
  };
  const waitFor = async <T>(
    probe: () => T | undefined | false,
    label: string,
  ) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const value = probe();
      if (value !== undefined && value !== false) {
        return value;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const dispose = async (): Promise<void> => {
    await handle.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  };
  const { api, terminalIds } = handle;
  const tools = { git, write, commitAll, initRepo, waitFor, dispose };
  return { root, dataDir, events, api, terminalIds, ...tools };
}

export function failureCode(work: Promise<unknown>): Promise<string> {
  const code = (error: unknown): string =>
    error instanceof RunnerError ? error.code : `unexpected: ${error}`;
  return work.then(() => "resolved", code);
}

export function byPath<T extends { path: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.path, item]));
}
