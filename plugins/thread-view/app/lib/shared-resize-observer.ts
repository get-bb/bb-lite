type Read = (entry: ResizeObserverEntry | undefined) => () => void;

const readsByTarget = new Map<Element, Set<Read>>();
let sharedResizeObserver: ResizeObserver | null = null;

export function observeSharedResize<T>(
  target: Element,
  phases: {
    read: (entry: ResizeObserverEntry | undefined) => T;
    write: (value: T) => void;
  },
): () => void {
  sharedResizeObserver ??= new ResizeObserver((entries) => {
    const writes = entries.flatMap((entry) =>
      [...(readsByTarget.get(entry.target) ?? [])].map((read) => read(entry)),
    );
    for (const write of writes) write();
  });
  const read: Read = (entry) => {
    const value = phases.read(entry);
    return () => phases.write(value);
  };
  const reads = readsByTarget.get(target) ?? new Set<Read>();
  if (reads.size === 0) {
    readsByTarget.set(target, reads);
    sharedResizeObserver.observe(target);
  }
  reads.add(read);
  return () => {
    reads.delete(read);
    if (reads.size > 0) return;
    readsByTarget.delete(target);
    sharedResizeObserver?.unobserve(target);
  };
}

export function observedBorderBoxBlockSize(
  entry: ResizeObserverEntry,
): number | undefined {
  return entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect?.height;
}
