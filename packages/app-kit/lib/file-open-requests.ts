type Open = (path: string) => void;

const panels = new Map<string, Open>();

export function onFileOpenRequest(threadId: string, open: Open): () => void {
  panels.set(threadId, open);
  return () => {
    if (panels.get(threadId) === open) panels.delete(threadId);
  };
}

export function requestFileOpen(threadId: string, path: string): boolean {
  const open = panels.get(threadId);
  open?.(path);
  return open !== undefined;
}
