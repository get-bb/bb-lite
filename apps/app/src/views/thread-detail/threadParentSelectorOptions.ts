import type { ThreadListEntry } from "@bb/domain";

interface ThreadAssignmentState {
  id: string;
  parentThreadId: string | null;
  visibility?: ThreadListEntry["visibility"];
}

export function isRootThread(
  thread: ThreadAssignmentState | undefined,
): boolean {
  return (
    thread !== undefined &&
    thread.parentThreadId === null &&
    thread.visibility !== "hidden"
  );
}

export function buildParentSelectorOptions({
  currentThreadId,
  parentThreads,
  parentThreadDisplayName,
  parentThreadId,
}: {
  currentThreadId: string | undefined;
  parentThreads: readonly ThreadListEntry[];
  parentThreadDisplayName: string | null | undefined;
  parentThreadId: string | null | undefined;
}): { label: string; value: string }[] {
  if (!currentThreadId) return [];
  const childrenOf = (id: string) =>
    parentThreads.filter((thread) => thread.parentThreadId === id);
  const excluded = new Set(["none", currentThreadId]);
  const stack = childrenOf(currentThreadId);
  for (let child = stack.pop(); child; child = stack.pop()) {
    if (excluded.has(child.id)) continue;
    excluded.add(child.id);
    stack.push(...childrenOf(child.id));
  }
  const options = [{ value: "none", label: "None" }];
  const addOption = (value: string | null | undefined, label: string) => {
    if (!value || excluded.has(value)) return;
    excluded.add(value);
    options.push({ value, label });
  };
  addOption(parentThreadId, parentThreadDisplayName ?? "Parent thread");
  const withChildren = new Set(
    parentThreads.map((thread) => thread.parentThreadId),
  );
  for (const hasChildren of [true, false]) {
    for (const thread of parentThreads) {
      if (
        thread.visibility !== "hidden" &&
        withChildren.has(thread.id) === hasChildren
      ) {
        addOption(
          thread.id,
          thread.title?.trim() ? thread.title : "Parent thread",
        );
      }
    }
  }
  return options;
}
