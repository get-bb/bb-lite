import type {
  GitSourceInspection,
  WorkspaceDiffTarget,
  WorkspaceStatus,
} from "@bb/domain";
import type {
  CommandListResponse,
  DiffFileEntry,
  DiffPatchEntry,
  EnvironmentDiffBranchesResponse,
  EnvironmentDiffFileQuery,
  EnvironmentDiffFileResponse,
  HostDirectoryListing,
  HostFileReadResponse,
  HostFileWriteResponse,
  HostOpenTarget,
  TerminalOutputChunk,
  WorkspacePathListResponse,
} from "@bb/server-contract";
import type { ProviderId, RunnerEvent } from "./types.js";

export const FILE_PAYLOAD_MAX_BYTES = 512 * 1024;
export const PATHS_EXIST_MAX_PATHS = 200;
export const PATH_LIST_MAX_ENTRIES = 2_000;
export const DIFF_MAX_FILES = 500;
export const DIFF_PATCH_MAX_PATHS = 50;
export const DIFF_PATCH_MAX_BYTES_PER_FILE = 256 * 1024;
export const DIFF_RESPONSE_MAX_BYTES = 600 * 1024;
export const STATUS_MAX_FILES = 1_000;
export const TERMINAL_REPLAY_MAX_BYTES = 512 * 1024;

export type WorkspaceEvent =
  | Extract<RunnerEvent, { lane: "live" }>
  | Omit<Extract<RunnerEvent, { kind: "script.output" }>, "seq">;

export type WorkspaceEventSink = (event: WorkspaceEvent) => void;

export interface PathInspection {
  exists: boolean;
  isGitRepo: boolean;
  isWorktree: boolean;
  branchName: string | null;
  defaultBranch: string | null;
  remoteUrl: string | null;
}

export interface DiffFiles {
  files: DiffFileEntry[];
  truncated: boolean;
  shortstat: string;
  mergeBaseRef: string | null;
  initialPatches: DiffPatchEntry[];
}

export interface WorktreeResult {
  path: string;
  branchName: string;
  mergeBaseBranch: string;
  worktreeInclude: { copied: number; skipped: number } | null;
}

export interface LifecycleScriptResult {
  ran: boolean;
  exitCode: number | null;
  failure: {
    reason: "exit" | "signal" | "timeout" | "cancelled";
    message: string;
  } | null;
}

export type FileContent = HostFileReadResponse;
export type FileContentEncoding = FileContent["contentEncoding"];

export interface FileChunk {
  path: string;
  sizeBytes: number;
  modifiedAtMs: number | null;
  mimeType: string | null;
  revision: string;
  offset: number;
  dataBase64: string;
}

export type FileWriteResult = HostFileWriteResponse;

export interface FileLocation {
  path: string;
  rootPath?: string;
}

export type PathMutation =
  | (FileLocation & { op: "mkdir"; recursive?: boolean })
  | (FileLocation & { op: "remove"; recursive?: boolean })
  | {
      op: "move";
      sourcePath: string;
      destinationPath: string;
      rootPath?: string;
    };

export type TerminalStart =
  | { mode: "shell" }
  | { mode: "command"; command: string };

export interface TerminalOpened {
  shell: string;
  title: string;
  initialCwd: string;
  cols: number;
  rows: number;
}

export interface TerminalReplay {
  chunks: TerminalOutputChunk[];
  replayStartSeq: number;
  nextSeq: number;
  exited: { exitCode: number | null } | null;
}

export type OpenTarget = HostOpenTarget;

interface DiffScope {
  path: string;
  target: WorkspaceDiffTarget;
}

interface TerminalRef {
  terminalId: string;
}

export interface WorkspaceApi {
  inspectPath(args: { path: string }): Promise<PathInspection>;
  inspectGitSource(args: { path: string }): Promise<GitSourceInspection>;
  listBranches(args: {
    path: string;
    query?: string;
    selectedBranch?: string;
    limit: number;
  }): Promise<EnvironmentDiffBranchesResponse>;
  gitStatus(args: {
    path: string;
    mergeBaseBranch?: string;
  }): Promise<WorkspaceStatus>;
  gitDiffFiles(args: DiffScope): Promise<DiffFiles>;
  gitDiffPatch(
    args: DiffScope & { paths: string[] },
  ): Promise<{ patches: DiffPatchEntry[] }>;
  gitDiffFile(args: {
    path: string;
    file: EnvironmentDiffFileQuery;
  }): Promise<EnvironmentDiffFileResponse>;
  gitCommit(args: {
    path: string;
    message: string;
  }): Promise<{ commitSha: string; commitSubject: string }>;

  createWorktree(args: {
    sourcePath: string;
    key: string;
    branchName: string;
    baseBranch: string | null;
  }): Promise<WorktreeResult>;
  removeWorktree(args: { path: string }): Promise<void>;
  ensurePersonalWorkspace(args: { key: string }): Promise<{ path: string }>;
  switchBranch(args: {
    path: string;
    branchName: string;
    createFrom: string | null;
  }): Promise<{ branchName: string }>;
  runLifecycleScript(args: {
    operationId: string;
    path: string;
    kind: "setup" | "teardown";
    timeoutMs: number;
    env: Record<string, string>;
  }): Promise<LifecycleScriptResult>;
  cancelOperation(args: {
    operationId: string;
  }): Promise<{ cancelled: boolean }>;

  readFile(args: FileLocation & { gitRef?: string }): Promise<FileContent>;
  readFileChunk(
    args: FileLocation & {
      gitRef?: string;
      offset: number;
      length: number;
      revision: string | null;
    },
  ): Promise<FileChunk>;
  writeFile(
    args: FileLocation & {
      content: string;
      contentEncoding?: FileContentEncoding;
      createParents?: boolean;
      expectedSha256?: string | null;
      mode?: number;
    },
  ): Promise<FileWriteResult>;
  writeFileChunk(
    args: FileLocation & {
      offset: number;
      dataBase64: string;
      createParents?: boolean;
      mode?: number;
    },
  ): Promise<{ sizeBytes: number }>;
  listPaths(args: {
    rootPath: string;
    query?: string;
    limit: number;
    includeFiles: boolean;
    includeDirectories: boolean;
    includeHidden?: boolean;
    excludeNames?: string[];
    fresh?: boolean;
  }): Promise<WorkspacePathListResponse>;
  browseDirectory(args: { path?: string }): Promise<HostDirectoryListing>;
  pathsExist(args: {
    paths: string[];
  }): Promise<{ existence: Record<string, boolean> }>;
  mutatePath(args: PathMutation): Promise<{ ok: true }>;

  listCommands(args: {
    providerId: ProviderId;
    cwd: string | null;
    nativeSkillRoots?: { user: string[]; project: string[] };
  }): Promise<CommandListResponse>;

  openTerminal(
    args: TerminalRef & {
      cwd: string | null;
      cols: number;
      rows: number;
      start: TerminalStart;
      env: Record<string, string>;
    },
  ): Promise<TerminalOpened>;
  attachTerminal(
    args: TerminalRef & { sinceSeq: number; tailBytes: number },
  ): Promise<TerminalReplay>;
  writeTerminal(args: TerminalRef & { dataBase64: string }): Promise<void>;
  resizeTerminal(
    args: TerminalRef & { cols: number; rows: number },
  ): Promise<void>;
  closeTerminal(args: TerminalRef): Promise<void>;

  setWatchedPaths(args: {
    generation: number;
    workspaces: string[];
    directories: string[];
  }): Promise<void>;

  listOpenTargets(): Promise<{ targets: OpenTarget[] }>;
  openInTarget(args: {
    targetId: string;
    path: string;
    line: number | null;
    column: number | null;
  }): Promise<void>;
}
