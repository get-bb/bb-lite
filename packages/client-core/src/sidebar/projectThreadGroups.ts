import type { ThreadListEntry } from "@bb/domain";

export interface SidebarSectionDefinition {
  id: string;
  name: string;
}

export const CHRONOLOGICAL_CONTAINER_ID = "chronological";

type SidebarProjectThreadShape = Pick<
  ThreadListEntry,
  "originKind" | "visibility"
>;

export function resolveSidebarProjectId(
  thread: ThreadListEntry,
  threadById: ReadonlyMap<string, ThreadListEntry>,
): string {
  const visitedThreadIds = new Set<string>([thread.id]);
  let current = thread;
  while (current.parentThreadId !== null) {
    const parent = threadById.get(current.parentThreadId);
    if (parent === undefined || visitedThreadIds.has(parent.id)) {
      break;
    }
    visitedThreadIds.add(parent.id);
    current = parent;
  }
  return current.projectId;
}

export function isSidebarProjectThread(
  thread: SidebarProjectThreadShape,
): boolean {
  return thread.visibility !== "hidden";
}
