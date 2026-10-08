import { useMemo } from "react";
import { shell, type ThreadRowStatus } from "@bb/plugin/app";
import { useSlot } from "@bb/app-kit/plugins/slots";

export function useSidebarThreadRowStatuses(): ReadonlyMap<
  string,
  ThreadRowStatus
> {
  const entries = useSlot(shell.threadRowStatus);
  return useMemo(() => {
    const statuses = new Map<string, ThreadRowStatus>();
    for (const { threadId, ...status } of entries) {
      statuses.set(threadId, status);
    }
    return statuses;
  }, [entries]);
}

export function useSidebarThreadRowStatus(
  threadId: string,
): ThreadRowStatus | null {
  return useSidebarThreadRowStatuses().get(threadId) ?? null;
}
