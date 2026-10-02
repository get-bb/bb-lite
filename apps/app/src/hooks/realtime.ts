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
  allEnvironmentDiffPatchQueryKeyPrefix,
  qk,
  terminalsQueryKey,
  threadTabsQueryKey,
} from "./queries/query-keys";
import { refresh, STREAM, type RefreshTiming } from "./queries/refresh";
import { patchCachedThreads } from "./queries/thread-cache";

type Keys = readonly QueryKey[];

const WORKSPACE: RefreshTiming = { delay: 250, gap: 1000 };

const listed = (id: string): Keys => [
  ...qk.threadListState(),
  qk.threadDetail(id),
];

const THREAD: Record<ThreadChangeKind, (id: string) => Keys> = {
  "thread-created": listed,
  "thread-deleted": qk.threadListState,
  "events-appended": () => [],
  "history-rewritten": (id) => [...listed(id), ...qk.threadState(id)],
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
    ...qk.threadStorageState(id),
  ],
  "read-state-changed": listed,
  "tabs-changed": (id) => [threadTabsQueryKey(id)],
  "terminals-changed": (id) => [
    terminalsQueryKey({ kind: "thread", threadId: id }),
  ],
};

const PROJECT: Record<ProjectChangeKind, () => Keys> = {
  "project-created": qk.projectState,
  "project-updated": qk.projectState,
  "project-deleted": qk.projectState,
  "project-sources-changed": qk.projectState,
  "threads-changed": qk.projectState,
  "project-order-changed": qk.projectState,
};

const ENVIRONMENT: Record<EnvironmentChangeKind, (id: string) => Keys> = {
  "environment-created": qk.environmentState,
  "environment-deleted": qk.environmentState,
  "metadata-changed": (id) => [
    ...qk.environmentState(id),
    ...qk.threadListState(),
  ],
  "status-changed": qk.environmentState,
  "work-status-changed": qk.environmentWorkspace,
  "git-refs-changed": qk.environmentState,
  "thread-storage-changed": () => qk.threadStorageState(),
};

const HOST: Record<HostChangeKind, () => Keys> = {
  "host-connected": () => [...qk.hostState(), ...qk.threadStorageState()],
  "host-disconnected": qk.hostState,
  "provider-model-catalog-changed": qk.hostState,
};

const SYSTEM: Record<SystemChangeKind, () => Keys> = {
  "config-changed": qk.systemState,
  "plugins-changed": qk.pluginState,
  "provider-registrations-changed": qk.systemState,
  "ui-preferences-changed": () => [qk.uiPreferences()],
  "environment-availability-changed": () => [qk.environmentProviders()],
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
  const { changes, entity } = message;
  if (entity === "system") {
    if (changes.includes("plugins-changed")) reloadPlugins();
    return refreshAll(changes.flatMap((kind) => SYSTEM[kind]()));
  }
  const { id } = message;
  if (id === undefined) return;
  if (entity === "thread") {
    const metadata = message.metadata ?? {};
    return refreshAll(threadChanged(client, id, message.changes, metadata));
  }
  if (entity === "project") {
    return refreshAll(message.changes.flatMap((kind) => PROJECT[kind]()));
  }
  if (entity === "host") {
    return refreshAll(message.changes.flatMap((kind) => HOST[kind]()));
  }
  if (!message.changes.includes("thread-storage-changed")) {
    bumpDiffPatchFreshnessGeneration(id);
  }
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
  client.removeQueries({ queryKey: allEnvironmentDiffPatchQueryKeyPrefix() });
  void client.invalidateQueries(undefined, { cancelRefetch: false });
}
