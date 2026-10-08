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

const submitted = new Map<string, Set<() => void>>();

export function onComposerSubmitted(
  key: string,
  listener: () => void,
): () => void {
  const waiting = submitted.get(key) ?? new Set<() => void>();
  submitted.set(key, waiting);
  waiting.add(listener);
  return () => waiting.delete(listener);
}

export function composerSubmitted(key: string): void {
  for (const listener of submitted.get(key) ?? []) listener();
}
