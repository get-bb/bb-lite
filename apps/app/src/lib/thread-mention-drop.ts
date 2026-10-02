export interface DroppedThreadMention {
  threadId: string;
  label: string;
}

const targets = new Map<
  HTMLElement,
  {
    accepts: () => boolean;
    insert: (thread: DroppedThreadMention, x: number, y: number) => void;
  }
>();

export function registerThreadMentionDropTarget(
  element: HTMLElement,
  target: {
    accepts: () => boolean;
    insert: (thread: DroppedThreadMention, x: number, y: number) => void;
  },
): () => void {
  targets.set(element, target);
  return () => {
    targets.delete(element);
  };
}
