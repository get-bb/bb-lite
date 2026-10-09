import { callOp, interactions } from "@bb/plugin/app";
import { useQueries } from "@tanstack/react-query";
import type { PendingInteraction } from "@bb/domain";
import { qk } from "@bb/app-kit/hooks/queries/query-keys";
import { getLatestPendingInteraction } from "@bb/app-kit/hooks/queries/thread-queries";

interface ChildThreadPendingAttentionSource {
  hasPendingInteraction: boolean;
  href: string;
  id: string;
  title: string;
}

export interface ChildThreadPendingAttention {
  childThreadId: string;
  childTitle: string;
  href: string;
  interaction: PendingInteraction;
}

const NONE: readonly ChildThreadPendingAttention[] = Object.freeze([]);

export function useChildThreadPendingAttention(
  children: readonly ChildThreadPendingAttentionSource[],
): readonly ChildThreadPendingAttention[] {
  const pending = children.filter((child) => child.hasPendingInteraction);
  return useQueries({
    queries: pending.map((child) => ({
      queryKey: qk.interactions(child.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        callOp(interactions.list, { threadId: child.id }, { signal }),
    })),
    combine: (results) => {
      const items = results.flatMap((result, index) => {
        const child = pending[index];
        const interaction = getLatestPendingInteraction(result.data);
        return child === undefined || interaction === null
          ? []
          : {
              childThreadId: child.id,
              childTitle: child.title,
              href: child.href,
              interaction,
            };
      });
      return items.length === 0 ? NONE : items;
    },
  });
}
