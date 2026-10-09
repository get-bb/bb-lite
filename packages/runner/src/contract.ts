import { contract, op, type Op } from "@bb/plugin";
import { z } from "zod";
import type { WorkspaceApi } from "./workspace-types.js";

const QUICK_MS = 15_000;
const STANDARD_MS = 60_000;
const LONG_MS = 10 * 60_000;
export const SCRIPT_GRACE_MS = 30_000;

type Method = keyof WorkspaceApi;
type Given<K extends Method> = Parameters<WorkspaceApi[K]>;
type Input<K extends Method> =
  Given<K> extends [infer Args] ? Args : Record<string, never>;
type Output<K extends Method> = Awaited<ReturnType<WorkspaceApi[K]>>;

export type MachineOp<K extends Method = Method> = Op<
  z.ZodType<Input<K>>,
  z.ZodType<Output<K>>
> & { readonly method: K; readonly timeoutMs: number };

function reads<K extends Method>(method: K, timeoutMs: number): MachineOp<K> {
  const input = z.custom<Input<K>>();
  const output = z.custom<Output<K>>();
  const declared = op({ input, output, hooks: "answer", internal: true });
  return { ...declared, method, timeoutMs };
}

function writes<K extends Method>(method: K, timeoutMs: number): MachineOp<K> {
  return { ...reads(method, timeoutMs), kind: "write" };
}

export const git = contract("git", {
  inspect: reads("inspectPath", STANDARD_MS),
  source: reads("inspectGitSource", STANDARD_MS),
  branches: reads("listBranches", STANDARD_MS),
  status: reads("gitStatus", STANDARD_MS),
  diffFiles: reads("gitDiffFiles", STANDARD_MS),
  diffPatch: reads("gitDiffPatch", STANDARD_MS),
  diffFile: reads("gitDiffFile", STANDARD_MS),
  commit: writes("gitCommit", LONG_MS),
  createWorktree: writes("createWorktree", LONG_MS),
  deleteWorktree: writes("removeWorktree", LONG_MS),
  switchBranch: writes("switchBranch", LONG_MS),
});

export const machineFiles = contract("machineFiles", {
  read: reads("readFile", STANDARD_MS),
  readChunk: reads("readFileChunk", STANDARD_MS),
  write: writes("writeFile", STANDARD_MS),
  writeChunk: writes("writeFileChunk", STANDARD_MS),
  list: reads("listPaths", STANDARD_MS),
  browse: reads("browseDirectory", STANDARD_MS),
  exist: reads("pathsExist", QUICK_MS),
  mutate: writes("mutatePath", STANDARD_MS),
});

export const machineTerminals = contract("machineTerminals", {
  open: writes("openTerminal", STANDARD_MS),
  attach: reads("attachTerminal", QUICK_MS),
  write: writes("writeTerminal", QUICK_MS),
  resize: writes("resizeTerminal", QUICK_MS),
  close: writes("closeTerminal", QUICK_MS),
});

export const workspaces = contract("workspaces", {
  ensurePersonal: writes("ensurePersonalWorkspace", LONG_MS),
  runScript: writes("runLifecycleScript", SCRIPT_GRACE_MS),
  cancelScript: writes("cancelOperation", QUICK_MS),
  watch: writes("setWatchedPaths", STANDARD_MS),
  commands: reads("listCommands", STANDARD_MS),
  openTargets: reads("listOpenTargets", QUICK_MS),
  openIn: writes("openInTarget", QUICK_MS),
});

export const MACHINE_OPS: readonly MachineOp[] = [
  git,
  machineFiles,
  machineTerminals,
  workspaces,
].flatMap((members) => Object.values(members) as MachineOp[]);
