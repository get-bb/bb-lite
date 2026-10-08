import { createContext, useContext, useSyncExternalStore } from "react";
import type { ComposerHandle } from "@bb/plugin/app";

const mounted = new Map<string, ComposerHandle>();
const listeners = new Set<() => void>();
let snapshot: readonly ComposerHandle[] = [];

function publish(): void {
  snapshot = [...mounted.values()];
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function showComposer(handle: ComposerHandle): () => void {
  mounted.delete(handle.key);
  mounted.set(handle.key, handle);
  publish();
  return () => {
    if (mounted.get(handle.key) !== handle) return;
    mounted.delete(handle.key);
    publish();
  };
}

export const BoundComposer = createContext<ComposerHandle | null>(null);

export function useComposers(): readonly ComposerHandle[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}

export function useComposer(): ComposerHandle | null {
  const bound = useContext(BoundComposer);
  const all = useComposers();
  if (bound === null) return all.at(-1) ?? null;
  return all.find(({ key }) => key === bound.key) ?? bound;
}
