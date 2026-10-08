import {
  realtimeSubscriptionTargetKey as targetKey,
  type EnvironmentChangeKind,
  type RealtimeSubscriptionTarget,
} from "@bb/domain";
import type { Disposer, ServerContext } from "@bb/server-kit/context";
import { getEnvironment } from "@bb/server-kit/db/environments";
import { refreshWorkspaceMetadata } from "@bb/server-kit/environments/workspace";

type EnvironmentIdsByPath = Map<string, string[]>;

const SYNC_DELAY_MS = 100;
const CHANGE_KINDS = {
  status: "work-status-changed",
  refs: "git-refs-changed",
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

export function startWorkspaceWatch(ctx: ServerContext): Disposer {
  const { db, hub, runners, log } = ctx;
  type Target = Extract<RealtimeSubscriptionTarget, { environmentId: string }>;
  const targets = new Map<string, Target>();
  type Sent = { fingerprint: string; set: EnvironmentIdsByPath };
  const sent = new Map<string, Sent>();
  let generation = 0;
  let timer: NodeJS.Timeout | undefined;

  const wantedByHost = () => {
    const wanted = new Map<string, EnvironmentIdsByPath>();
    for (const { environmentId } of targets.values()) {
      const found = getEnvironment(db, environmentId);
      if (found?.status !== "ready" || !found.path) continue;
      const paths = wanted.get(found.hostId) ?? new Map<string, string[]>();
      paths.set(found.path, [...(paths.get(found.path) ?? []), found.id]);
      wanted.set(found.hostId, paths);
    }
    return wanted;
  };

  const sync = () => {
    timer = undefined;
    const wanted = wantedByHost();
    for (const hostId of new Set([...wanted.keys(), ...sent.keys()])) {
      const set = wanted.get(hostId) ?? new Map<string, string[]>();
      const workspaces = [...set.keys()].sort();
      const fingerprint = JSON.stringify(workspaces);
      const unchanged = sent.get(hostId)?.fingerprint === fingerprint;
      if (!runners.isConnected(hostId)) continue;
      if (wanted.has(hostId)) sent.set(hostId, { fingerprint, set });
      else sent.delete(hostId);
      if (unchanged) continue;
      generation = Math.max(Date.now(), generation + 1);
      runners
        .get(hostId)
        .setWatchedPaths({ generation, workspaces, directories: [] })
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
      if (target.kind !== "environment-detail") return;
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
      if (change === "files") return;
      for (const environmentId of sent.get(hostId)?.set.get(path) ?? []) {
        hub.environment(environmentId, [CHANGE_KINDS[change]]);
        refreshMetadata(environmentId, change === "refs");
      }
    }),
  ];

  return () => {
    clearTimeout(timer);
    stops.forEach((stop) => stop());
  };
}
