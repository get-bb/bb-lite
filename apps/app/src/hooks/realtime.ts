import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  ChangedMessage,
  EnvironmentChangeKind,
  HostChangeKind,
  ProjectChangeKind,
  SystemChangeKind,
  ThreadChangeKind,
  ThreadChangeMetadata,
} from "@bb/domain";
import { reloadPlugins } from "@/plugins/external";
import {
  bumpAllDiffPatchEvictionGenerations,
  bumpDiffPatchFreshnessGeneration,
} from "./cache-owners/environment-diff-patch-cache-owner";
import { dropCachedThread } from "./mutations/thread-state-mutations";
import {
  environmentDiffPatchQueryKeyPrefix,
  qk,
  terminalsQueryKey,
  threadTabsQueryKey,
} from "./queries/query-keys";
import { ANY, refresh, STREAM, type RefreshTiming } from "./queries/refresh";
import { patchCachedThreads } from "./queries/thread-cache";

type Keys = readonly QueryKey[];

const WORKSPACE: RefreshTiming = { delay: 250, gap: 1000 };

const listed = (id: string): Keys => [...qk.threadLists(), qk.threadDetail(id)];
const projectState = (id: string): Keys => [
  ...qk.threadLists(),
  qk.project(id),
  qk.hostPaths(),
];
const workspace = (id: string): Keys => [
  qk.environmentStatus(id),
  qk.environmentDiffFiles(id),
  qk.environmentFile(id),
];
const hostState = (): Keys => [
  qk.hosts(),
  qk.sidebar(),
  qk.systemProviders(),
  qk.executionOptions(),
  qk.environmentProviders(),
  qk.hostPaths(),
];

const THREAD: Record<ThreadChangeKind, (id: string) => Keys> = {
  "thread-created": listed,
  "thread-deleted": qk.threadLists,
  "events-appended": () => [],
  "history-rewritten": (id) => [...qk.threadLists(), qk.thread(id)],
  "interactions-changed": (id) => [qk.interactions(id)],
  "status-changed": (id) => [qk.threadDetail(id)],
  "title-changed": listed,
  "queue-changed": (id) => [
    ...listed(id),
    qk.queue(id),
    qk.threadPromptHistory(id),
  ],
  "archived-changed": listed,
  "pin-state-changed": listed,
  "parent-changed": listed,
  "environment-changed": (id) => [
    ...listed(id),
    qk.threadBootstrap(id),
    qk.threadExecution(id),
  ],
  "read-state-changed": listed,
  "tabs-changed": (id) => [threadTabsQueryKey(id)],
  "terminals-changed": (id) => [
    terminalsQueryKey({ kind: "thread", threadId: id }),
  ],
};

const PROJECT: Record<ProjectChangeKind, (id: string) => Keys> = {
  "project-created": projectState,
  "project-updated": projectState,
  "project-deleted": projectState,
  "project-sources-changed": projectState,
  "threads-changed": projectState,
};

const ENVIRONMENT: Record<EnvironmentChangeKind, (id: string) => Keys> = {
  "environment-created": (id) => [qk.environment(id)],
  "environment-deleted": (id) => [qk.environment(id)],
  "metadata-changed": (id) => [qk.environment(id), ...qk.threadLists()],
  "status-changed": (id) => [qk.environment(id)],
  "work-status-changed": workspace,
  "git-refs-changed": (id) => [...workspace(id), qk.environmentBranches(id)],
};

const HOST: Record<HostChangeKind, () => Keys> = {
  "host-connected": hostState,
  "host-disconnected": hostState,
  "provider-model-catalog-changed": () => [qk.executionOptions()],
};

const SYSTEM: Record<SystemChangeKind, () => Keys> = {
  "config-changed": () => [qk.system(), qk.timeline(ANY), qk.turnDetails(ANY)],
  "plugins-changed": () => [
    qk.plugins(),
    qk.systemConfig(),
    qk.environmentProviders(),
    qk.project(ANY, "commands"),
  ],
  "ui-preferences-changed": () => [qk.uiPreferences()],
  "users-changed": () => [
    qk.users(),
    qk.userInvites(),
    qk.authSession(),
    qk.hosts(),
  ],
};

function threadChanged(
  client: QueryClient,
  id: string,
  changes: readonly ThreadChangeKind[],
  metadata: ThreadChangeMetadata,
): Keys {
  const { eventTypes = [], hasPendingInteraction, statusChange } = metadata;
  const keys = changes.flatMap((kind) => THREAD[kind](id));
  if (changes.includes("thread-deleted")) dropCachedThread(client, id);
  if (statusChange) patchCachedThreads(client, () => statusChange, [id]);
  else if (changes.includes("status-changed")) keys.push(...listed(id));
  if (hasPendingInteraction !== undefined) {
    patchCachedThreads(client, () => ({ hasPendingInteraction }), [id]);
  }
  if (!changes.includes("events-appended")) return keys;
  refresh(client, qk.timeline(id), STREAM);
  if (metadata.backgroundActivityChanged) keys.push(...listed(id));
  if (eventTypes.includes("turn/completed")) keys.push(qk.threadSearch());
  if (eventTypes.includes("client/turn/requested")) {
    keys.push(qk.threadExecution(id), qk.threadPromptHistory(id));
  }
  return keys;
}

export function applyChange(client: QueryClient, message: ChangedMessage) {
  const refreshAll = (keys: Keys, timing?: RefreshTiming) =>
    keys.forEach((queryKey) => refresh(client, queryKey, timing));
  if (message.entity === "system") {
    if (message.changes.includes("plugins-changed")) reloadPlugins();
    return refreshAll(message.changes.flatMap((kind) => SYSTEM[kind]()));
  }
  const { id } = message;
  if (id === undefined) return;
  if (message.entity === "thread") {
    const metadata = message.metadata ?? {};
    return refreshAll(threadChanged(client, id, message.changes, metadata));
  }
  if (message.entity === "project") {
    return refreshAll(message.changes.flatMap((kind) => PROJECT[kind](id)));
  }
  if (message.entity === "host") {
    return refreshAll(message.changes.flatMap((kind) => HOST[kind]()));
  }
  bumpDiffPatchFreshnessGeneration(id);
  refreshAll(
    message.changes.flatMap((kind) => ENVIRONMENT[kind](id)),
    WORKSPACE,
  );
}

export function resync(client: QueryClient, reconnected: boolean): void {
  if (!reconnected) {
    void client.refetchQueries({
      type: "active",
      predicate: (query) => query.state.status === "error",
    });
    return;
  }
  reloadPlugins();
  bumpAllDiffPatchEvictionGenerations();
  client.removeQueries({ queryKey: environmentDiffPatchQueryKeyPrefix() });
  void client.invalidateQueries(undefined, { cancelRefetch: false });
}
