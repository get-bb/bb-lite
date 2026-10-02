import { useEffect } from "react";
import { wsManager } from "@/lib/ws";

interface RealtimeSubscriptionOptions {
  enabled?: boolean;
}

export function useThreadDetailRealtimeSubscription(
  threadId: string | null | undefined,
  options?: RealtimeSubscriptionOptions,
): void {
  const id = (options?.enabled ?? true) ? threadId : null;
  useEffect(
    () =>
      id
        ? wsManager.subscribe({ kind: "thread-detail", threadId: id })
        : undefined,
    [id],
  );
}

export function useEnvironmentDetailRealtimeSubscription(
  environmentId: string | null | undefined,
  options?: RealtimeSubscriptionOptions,
): void {
  const id = (options?.enabled ?? true) ? environmentId : null;
  useEffect(
    () =>
      id
        ? wsManager.subscribe({ kind: "environment-detail", environmentId: id })
        : undefined,
    [id],
  );
}
