import { useSyncExternalStore } from "react";
import type { PluginSidebarThreadRowStatus } from "@bb/plugin/app";

type Statuses = ReadonlyMap<string, PluginSidebarThreadRowStatus>;

const byPlugin = new Map<string, Map<string, PluginSidebarThreadRowStatus>>();
const listeners = new Set<() => void>();
let snapshot: Statuses = new Map();

function publish(): void {
  const merged = new Map<string, PluginSidebarThreadRowStatus>();
  for (const statuses of byPlugin.values()) {
    for (const [threadId, status] of statuses) merged.set(threadId, status);
  }
  snapshot = merged;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setThreadRowStatus(
  pluginId: string,
  threadId: string,
  status: PluginSidebarThreadRowStatus | null,
): void {
  const statuses = byPlugin.get(pluginId) ?? new Map();
  byPlugin.set(pluginId, statuses);
  if (status === null) statuses.delete(threadId);
  else statuses.set(threadId, status);
  publish();
}

export function clearThreadRowStatuses(pluginId: string): void {
  if (byPlugin.delete(pluginId)) publish();
}

export function useThreadRowStatuses(): Statuses {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}

export function useThreadRowStatus(
  threadId: string,
): PluginSidebarThreadRowStatus | null {
  return useThreadRowStatuses().get(threadId) ?? null;
}
