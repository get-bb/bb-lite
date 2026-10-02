import { join } from "node:path";
import {
  realtimeSubscriptionTargetKey as targetKey,
  type EnvironmentChangeKind,
  type RealtimeSubscriptionTarget,
} from "@bb/domain";
import type { ServerContext } from "../context.js";
import { getEnvironment } from "../db/environments.js";
import { findHost } from "../db/hosts.js";
import { getThread } from "../db/threads.js";
import type { Disposer } from "../server.js";
import { refreshWorkspaceMetadata } from "./workspace.js";

type EnvironmentIdsByPath = Map<string, string[]>;

interface WatchSet {
  workspaces: EnvironmentIdsByPath;
  directories: EnvironmentIdsByPath;
}

const SYNC_DELAY_MS = 100;
const CHANGE_KINDS = {
  status: "work-status-changed",
  refs: "git-refs-changed",
  files: "thread-storage-changed",
} as const satisfies Record<string, EnvironmentChangeKind>;
const RETARGETING_CHANGES: ReadonlySet<string> = new Set([
  "environment-created",
  "environment-deleted",
  "metadata-changed",
  "status-changed",
  "archived-changed",
  "environment-changed",
  "thread-created",
  "thread-deleted",
]);

function emptyWatchSet(): WatchSet {
  return { workspaces: new Map(), directories: new Map() };
}

function watch(paths: EnvironmentIdsByPath, path: string, id: string) {
  paths.set(path, [...(paths.get(path) ?? []), id]);
}

export function startWorkspaceWatch(ctx: ServerContext): Disposer {
  const { db, hub, runners, log } = ctx;
  const targets = new Map<string, RealtimeSubscriptionTarget>();
  const sent = new Map<string, { fingerprint: string; set: WatchSet }>();
  let generation = 0;
  let timer: NodeJS.Timeout | undefined;

  const wantedByHost = () => {
    const wanted = new Map<string, WatchSet>();
    const on = (hostId: string): WatchSet => {
      const set = wanted.get(hostId) ?? emptyWatchSet();
      wanted.set(hostId, set);
      return set;
    };
    for (const target of targets.values()) {
      if (target.kind === "environment-detail") {
        const found = getEnvironment(db, target.environmentId);
        if (found?.status !== "ready" || !found.path) continue;
        watch(on(found.hostId).workspaces, found.path, found.id);
      } else if (target.kind === "thread-detail") {
        const thread = getThread(db, target.threadId);
        const closed = thread?.archivedAt !== null || thread.deletedAt !== null;
        if (!thread?.environmentId || closed) continue;
        const found = getEnvironment(db, thread.environmentId);
        if (found === undefined || found.status === "destroyed") continue;
        const root = findHost(db, "id", found.hostId)?.threadStorageRoot;
        if (!root) continue;
        const storage = join(root, target.threadId);
        watch(on(found.hostId).directories, storage, found.id);
      }
    }
    return wanted;
  };

  const sync = () => {
    timer = undefined;
    const wanted = wantedByHost();
    for (const hostId of new Set([...wanted.keys(), ...sent.keys()])) {
      const set = wanted.get(hostId) ?? emptyWatchSet();
      const workspaces = [...set.workspaces.keys()].sort();
      const directories = [...set.directories.keys()].sort();
      const fingerprint = JSON.stringify([workspaces, directories]);
      const unchanged = sent.get(hostId)?.fingerprint === fingerprint;
      if (!runners.isConnected(hostId)) continue;
      if (wanted.has(hostId)) sent.set(hostId, { fingerprint, set });
      else sent.delete(hostId);
      if (unchanged) continue;
      generation = Math.max(Date.now(), generation + 1);
      runners
        .get(hostId)
        .setWatchedPaths({ generation, workspaces, directories })
        .catch((error: unknown) => {
          sent.delete(hostId);
          log.warn("Could not update watched paths", { err: error, hostId });
        });
    }
  };

  const schedule = () => {
    timer ??= setTimeout(sync, SYNC_DELAY_MS).unref();
  };

  const refreshMetadata = (environmentId: string, refs: boolean) => {
    const found = getEnvironment(db, environmentId);
    if (found?.status !== "ready" || !found.path) return;
    if (!refs && found.isGitRepo) return;
    const { path } = found;
    refreshWorkspaceMetadata(ctx, { ...found, path }).catch(
      (error: unknown) => {
        log.warn("Could not refresh workspace metadata", {
          err: error,
          environmentId,
        });
      },
    );
  };

  const stops = [
    hub.onSubscriptionChange((target, subscribed) => {
      const { kind } = target;
      if (kind !== "thread-detail" && kind !== "environment-detail") return;
      if (subscribed) targets.set(targetKey(target), target);
      else targets.delete(targetKey(target));
      schedule();
    }),
    hub.onChanged(({ entity, changes }) => {
      if (entity !== "thread" && entity !== "environment") return;
      const retargets = changes.some((kind) => RETARGETING_CHANGES.has(kind));
      if (retargets && targets.size > 0) schedule();
    }),
    runners.onConnected((hostId) => {
      sent.delete(hostId);
      schedule();
    }),
    runners.onDisconnected((hostId) => void sent.delete(hostId)),
    runners.onEvent("workspace.changed", ({ path, change }, hostId) => {
      const set = sent.get(hostId)?.set;
      const watched = change === "files" ? set?.directories : set?.workspaces;
      for (const environmentId of watched?.get(path) ?? []) {
        hub.environment(environmentId, [CHANGE_KINDS[change]]);
        if (change !== "files")
          refreshMetadata(environmentId, change === "refs");
      }
    }),
  ];

  return () => {
    clearTimeout(timer);
    stops.forEach((stop) => stop());
  };
}
