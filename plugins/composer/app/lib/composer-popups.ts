import { useSyncExternalStore } from "react";

const openPopups = new Map<string, string>();
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

export function openComposerPopup(composerKey: string, id: string): void {
  if (openPopups.get(composerKey) === id) return;
  openPopups.set(composerKey, id);
  changed();
}

export function closeComposerPopup(composerKey: string, id?: string): void {
  const current = openPopups.get(composerKey);
  if (current === undefined || (id !== undefined && current !== id)) return;
  openPopups.delete(composerKey);
  changed();
}

export function openComposerPopupId(composerKey: string): string | null {
  return openPopups.get(composerKey) ?? null;
}

export function subscribeComposerPopups(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOpenComposerPopupId(composerKey: string): string | null {
  return useSyncExternalStore(subscribeComposerPopups, () =>
    openComposerPopupId(composerKey),
  );
}
