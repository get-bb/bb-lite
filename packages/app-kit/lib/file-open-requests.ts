import type { FileSource } from "@bb/plugin/app";

type Open = (path: string, source?: FileSource) => void;

const panels = new Map<string, Open>();

export function onFileOpenRequest(threadId: string, open: Open): () => void {
  panels.set(threadId, open);
  return () => {
    if (panels.get(threadId) === open) panels.delete(threadId);
  };
}

export function requestFileOpen(
  threadId: string,
  path: string,
  source?: FileSource,
): boolean {
  const open = panels.get(threadId);
  open?.(path, source);
  return open !== undefined;
}
