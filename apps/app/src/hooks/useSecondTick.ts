import { useSyncExternalStore } from "react";
import {
  isDocumentVisible,
  subscribeToDocumentVisibility,
} from "@/lib/document-visibility";

const listeners = new Set<() => void>();
let lastTickMs = Date.now();
let stop = () => {};

function tick(): void {
  if (!isDocumentVisible()) return;
  lastTickMs = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    lastTickMs = Date.now();
    const intervalId = setInterval(tick, 1_000);
    const unsubscribeVisibility = subscribeToDocumentVisibility(tick);
    stop = () => {
      clearInterval(intervalId);
      unsubscribeVisibility();
    };
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

export function useSecondTick(): number {
  return useSyncExternalStore(subscribe, () => lastTickMs);
}
