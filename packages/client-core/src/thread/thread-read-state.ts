import type { Thread } from "@bb/domain";

export type ThreadReadState = Pick<Thread, "lastReadAt" | "latestAttentionAt">;

export function isThreadRead(thread: ThreadReadState): boolean {
  return (thread.lastReadAt ?? 0) >= thread.latestAttentionAt;
}

export function getThreadReadToggleAction(
  thread: ThreadReadState,
): "mark_read" | "mark_unread" {
  return isThreadRead(thread) ? "mark_unread" : "mark_read";
}
