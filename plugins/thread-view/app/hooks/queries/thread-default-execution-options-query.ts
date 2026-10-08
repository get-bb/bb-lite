import { useQuery } from "@tanstack/react-query";
import { resolvedThreadExecutionOptionsSchema } from "@bb/domain";
import { createLastKnownCache } from "@bb/app-kit/lib/last-known-cache";
import { sdk } from "@bb/app-kit/lib/sdk";
import { useThreadDetailRealtimeSubscription } from "@bb/app-kit/hooks/useRealtimeSubscription";
import { qk } from "@bb/app-kit/hooks/queries/query-keys";

const lastKnown = createLastKnownCache({
  prefix: "bb.thread-execution-options",
  version: "1",
  schema: resolvedThreadExecutionOptionsSchema,
  maxEntries: 50,
});

export function useThreadDefaultExecutionOptions(
  id: string,
  options?: { enabled?: boolean },
) {
  const enabled = (options?.enabled ?? true) && Boolean(id);
  useThreadDetailRealtimeSubscription(id, { enabled });
  return useQuery({
    queryKey: qk.threadExecution(id),
    queryFn: async ({ signal }) => {
      const args = { threadId: id, signal };
      const execution = await sdk.threads.defaultExecutionOptions(args);
      if (execution !== null) lastKnown.write(lastKnown.key(id), execution);
      return execution;
    },
    enabled,
    placeholderData: () => lastKnown.read(lastKnown.key(id)) ?? undefined,
  });
}
