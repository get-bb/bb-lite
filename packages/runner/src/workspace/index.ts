import path from "node:path";
import { listCommands, resolveSkillDirs } from "../files/commands.js";
import { browseDirectory, listPaths, pathsExist } from "../files/list.js";
import { readFile, readFileChunk } from "../files/read.js";
import { mutatePath, writeFile, writeFileChunk } from "../files/write.js";
import {
  createLoginShellChildEnv,
  type ChildEnv,
} from "../terminals/shell-env.js";
import { createTerminals } from "../terminals/terminals.js";
import type { WorkspaceApi, WorkspaceEventSink } from "../workspace-types.js";
import { gitDiff, gitDiffFile, gitDiffFiles, gitDiffPatch } from "./diff.js";
import { createKeyedLock, toRunnerError, type Ctx } from "./exec.js";
import {
  gitCommit,
  gitStatus,
  inspectGitSource,
  inspectPath,
  listBranches,
} from "./git.js";
import { listOpenTargets, openInTarget } from "./open-targets.js";
import { createLifecycleScripts } from "./scripts.js";
import { createWatcher } from "./watch.js";
import {
  createWorktree,
  ensurePersonalWorkspace,
  removeWorktree,
  switchBranch,
} from "./worktrees.js";

export interface WorkspaceDeps {
  dataDir: string;
  sink: WorkspaceEventSink;
  env?: ChildEnv;
}

export interface WorkspaceHandle {
  api: WorkspaceApi;
  terminalIds(): string[];
  dispose(): Promise<void>;
}

function guard<A extends unknown[], R>(
  method: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args) => {
    try {
      return await method(...args);
    } catch (error) {
      throw toRunnerError(error);
    }
  };
}

export function createWorkspaceApi(deps: WorkspaceDeps): WorkspaceHandle {
  const ctx: Ctx = {
    dataDir: path.resolve(deps.dataDir),
    sink: deps.sink,
    env: deps.env ?? createLoginShellChildEnv(),
    lock: createKeyedLock(),
  };
  const scripts = createLifecycleScripts(ctx);
  const terminals = createTerminals(ctx);
  const watcher = createWatcher(ctx);
  const bind = <A extends unknown[], R>(
    method: (context: Ctx, ...args: A) => Promise<R>,
  ): ((...args: A) => Promise<R>) => guard((...args) => method(ctx, ...args));

  return {
    api: {
      inspectPath: bind(inspectPath),
      inspectGitSource: bind(inspectGitSource),
      listBranches: bind(listBranches),
      gitStatus: bind(gitStatus),
      gitDiff: bind(gitDiff),
      gitDiffFiles: bind(gitDiffFiles),
      gitDiffPatch: bind(gitDiffPatch),
      gitDiffFile: bind(gitDiffFile),
      gitCommit: bind(gitCommit),
      createWorktree: bind(createWorktree),
      removeWorktree: bind(removeWorktree),
      ensurePersonalWorkspace: bind(ensurePersonalWorkspace),
      switchBranch: bind(switchBranch),
      runLifecycleScript: guard(scripts.run),
      cancelOperation: guard(scripts.cancel),
      readFile: bind(readFile),
      readFileChunk: bind(readFileChunk),
      writeFile: bind(writeFile),
      writeFileChunk: bind(writeFileChunk),
      listPaths: bind(listPaths),
      browseDirectory: bind(browseDirectory),
      pathsExist: bind(pathsExist),
      mutatePath: bind(mutatePath),
      listCommands: bind(listCommands),
      resolveSkillDirs: bind(resolveSkillDirs),
      openTerminal: guard(terminals.open),
      attachTerminal: guard(terminals.attach),
      writeTerminal: guard(terminals.write),
      resizeTerminal: guard(terminals.resize),
      closeTerminal: guard(terminals.close),
      setWatchedPaths: guard(watcher.setWatchedPaths),
      listOpenTargets: bind(listOpenTargets),
      openInTarget: bind(openInTarget),
    },
    terminalIds: terminals.liveIds,
    async dispose() {
      terminals.dispose();
      await Promise.all([scripts.dispose(), watcher.dispose()]);
    },
  };
}
