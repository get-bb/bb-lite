import type { ThreadListEntry } from "@bb/domain";
import {
  isSidebarProjectThread,
  isThreadRead,
  type ThreadReadState,
} from "@bb/client-core";

type FaviconSidebarThread = ThreadReadState &
  Pick<
    ThreadListEntry,
    | "hasPendingInteraction"
    | "id"
    | "originKind"
    | "parentThreadId"
    | "visibility"
  >;

export function shouldShowFaviconAttentionDot({
  currentThreadHasPendingInteraction,
  currentThreadId,
  isThreadView,
  sidebarThreads,
  thread,
}: {
  currentThreadHasPendingInteraction: boolean;
  currentThreadId?: string | null;
  isThreadView: boolean;
  sidebarThreads: readonly FaviconSidebarThread[];
  thread: ThreadReadState | null | undefined;
}): boolean {
  if (!isThreadView) {
    return sidebarThreads.some(
      (candidate) =>
        isSidebarProjectThread(candidate) &&
        (candidate.hasPendingInteraction || !isThreadRead(candidate)),
    );
  }
  return (
    currentThreadHasPendingInteraction ||
    Boolean(thread && !isThreadRead(thread)) ||
    (currentThreadId != null &&
      sidebarThreads.some(
        (candidate) =>
          candidate.parentThreadId === currentThreadId &&
          candidate.originKind === null &&
          candidate.hasPendingInteraction,
      ))
  );
}
