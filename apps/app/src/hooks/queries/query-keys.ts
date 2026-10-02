import type { QueryKey } from "@tanstack/react-query";
import type { WorkspaceDiffTarget } from "@bb/domain";

export type TerminalQueryScope =
  | { kind: "thread"; threadId: string }
  | { kind: "environment"; environmentId: string }
  | { kind: "host_path"; cwd?: string; hostId: string };

type Id = string | null | undefined;

function key(...parts: unknown[]): QueryKey {
  while (parts.length > 0 && parts.at(-1) === undefined) parts.pop();
  return parts;
}

const thread = (id: Id, ...rest: unknown[]) => key("thread", id, ...rest);
const project = (id: Id, ...rest: unknown[]) => key("project", id, ...rest);
const environment = (id: Id, ...rest: unknown[]) =>
  key("environment", id, ...rest);
const system = (...rest: unknown[]) => key("system", ...rest);
const plugins = (...rest: unknown[]) => key("plugins", ...rest);

export const qk = {
  sidebar: () => key("sidebar"),
  archivedThreads: () => key("archived-threads"),
  threadSearch: (filters?: object) => key("thread-search", filters),
  threadLists: () => [qk.sidebar(), qk.archivedThreads(), qk.threadSearch()],

  thread,
  threadDetail: (id: Id) => thread(id, "detail"),
  threadBootstrap: (id: Id) => thread(id, "bootstrap"),
  timeline: (id: Id) => thread(id, "timeline"),
  turnDetails: (id: Id, turn?: object) => thread(id, "turn-details", turn),
  queue: (id: Id) => thread(id, "queue"),
  interactions: (id: Id) => thread(id, "interactions"),
  threadPromptHistory: (id: Id) => thread(id, "prompt-history"),
  threadExecution: (id: Id) => thread(id, "execution-options"),
  threadStorage: (id: Id, kind?: string, args?: unknown) =>
    thread(id, "storage", kind, args),
  threadHostFile: (id: Id, environmentId: Id, path: Id) =>
    thread(id, "host-file", environmentId, path),

  project,
  projectPromptHistory: (id: Id) => project(id, "prompt-history"),
  projectExecution: (id: Id) => project(id, "execution-options"),
  projectBranches: (id: Id, args?: object) => project(id, "branches", args),
  projectPaths: (id: Id, args: object) => project(id, "paths", args),
  projectCommands: (id: Id, args: object) => project(id, "commands", args),

  environment,
  environmentRecord: (id: Id) => environment(id, "record"),
  environmentStatus: (id: Id, mergeBaseBranch?: string) =>
    environment(id, "status", mergeBaseBranch),
  environmentDiffFiles: (id: Id, target?: object) =>
    environment(id, "diff-files", target),
  environmentBranches: (id: Id, args?: object) =>
    environment(id, "branches", args),
  environmentPaths: (id: Id, args: object) => environment(id, "paths", args),
  environmentFile: (id: Id, path?: Id, source?: unknown) =>
    environment(id, "file", path, source),

  hosts: (includeCreating?: boolean) => key("hosts", includeCreating),
  hostDirectory: (hostId: Id, path: Id) => key("host-directory", hostId, path),
  hostPaths: (hostId?: Id, paths?: readonly string[]) =>
    key("host-paths", hostId, paths),

  system,
  systemConfig: () => system("config"),
  systemProviders: (query?: object) => system("providers", query),
  providerCatalog: () => system("provider-catalog"),
  executionOptions: (route?: object, providerId?: string) =>
    system("execution-options", route, providerId),
  environmentProviders: (query?: object) =>
    system("environment-providers", query),
  machineEnvironment: (projectId?: string | null) =>
    system("machine-environment", projectId),
  uiPreferences: () => key("ui-preferences"),

  plugins,
  pluginList: () => plugins("list"),
  pluginSettings: (pluginId: string) => plugins("settings", pluginId),
  pluginContributions: () => plugins("contributions"),
  pluginMentionSearch: (args: {
    trigger: string;
    query: string;
    projectId: string | null;
    threadId: string | null;
  }) =>
    plugins(
      "mention-search",
      args.trigger,
      args.query,
      args.projectId,
      args.threadId,
    ),
};

export const machineEnvironmentQueryKey = qk.machineEnvironment;
export const threadTimelineQueryKey = qk.timeline;

export const terminalsQueryKey = (scope: TerminalQueryScope) =>
  ["terminals", scope] as const;
export const allTerminalsQueryKeyPrefix = () => ["terminals"] as const;
export const threadTabsQueryKey = (threadId: string) =>
  ["threadTabs", threadId] as const;

export function environmentDiffTargetKey(
  target: WorkspaceDiffTarget | null | undefined,
): string | null {
  switch (target?.type) {
    case "commit":
      return target.sha;
    case "branch_committed":
    case "all":
      return target.mergeBaseBranch;
    default:
      return null;
  }
}

export const environmentDiffPatchQueryKeyPrefix = (environmentId?: string) =>
  key("environmentDiffPatch", environmentId);
export const environmentDiffPatchQueryKey = (
  environmentId: string,
  targetType: string | null,
  targetKey: string | null,
  path: string,
) =>
  ["environmentDiffPatch", environmentId, targetType, targetKey, path] as const;
export const environmentDiffFileQueryKey = (
  environmentId: string,
  targetType: string,
  targetKey: string | null,
  path: string,
  side: "old" | "new",
) =>
  [
    "environmentDiffFile",
    environmentId,
    targetType,
    targetKey,
    path,
    side,
  ] as const;
