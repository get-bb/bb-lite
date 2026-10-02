import path from "node:path";
import * as commands from "../files/commands.js";
import * as list from "../files/list.js";
import * as read from "../files/read.js";
import * as write from "../files/write.js";
import { loginShellEnv, type ChildEnv } from "../sessions/agent-env.js";
import { createTerminals } from "../terminals/terminals.js";
import type { WorkspaceApi, WorkspaceEventSink } from "../workspace-types.js";
import * as diff from "./diff.js";
import { createKeyedLock, toRunnerError, type Ctx } from "./exec.js";
import * as git from "./git.js";
import * as targets from "./open-targets.js";
import { createLifecycleScripts } from "./scripts.js";
import { createWatcher } from "./watch.js";
import * as worktrees from "./worktrees.js";

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
    env: deps.env ?? loginShellEnv(),
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
      inspectPath: bind(git.inspectPath),
      inspectGitSource: bind(git.inspectGitSource),
      listBranches: bind(git.listBranches),
      gitStatus: bind(git.gitStatus),
      gitDiffFiles: bind(diff.gitDiffFiles),
      gitDiffPatch: bind(diff.gitDiffPatch),
      gitDiffFile: bind(diff.gitDiffFile),
      gitCommit: bind(git.gitCommit),
      createWorktree: bind(worktrees.createWorktree),
      removeWorktree: bind(worktrees.removeWorktree),
      ensurePersonalWorkspace: bind(worktrees.ensurePersonalWorkspace),
      switchBranch: bind(worktrees.switchBranch),
      runLifecycleScript: guard(scripts.run),
      cancelOperation: guard(scripts.cancel),
      readFile: bind(read.readFile),
      readFileChunk: bind(read.readFileChunk),
      writeFile: bind(write.writeFile),
      writeFileChunk: bind(write.writeFileChunk),
      listPaths: bind(list.listPaths),
      browseDirectory: bind(list.browseDirectory),
      pathsExist: bind(list.pathsExist),
      mutatePath: bind(write.mutatePath),
      listCommands: bind(commands.listCommands),
      openTerminal: guard(terminals.open),
      attachTerminal: guard(terminals.attach),
      writeTerminal: guard(terminals.write),
      resizeTerminal: guard(terminals.resize),
      closeTerminal: guard(terminals.close),
      setWatchedPaths: guard(watcher.setWatchedPaths),
      listOpenTargets: bind(targets.listOpenTargets),
      openInTarget: bind(targets.openInTarget),
    },
    terminalIds: terminals.liveIds,
    async dispose() {
      terminals.dispose();
      await Promise.all([scripts.dispose(), watcher.dispose()]);
    },
  };
}
