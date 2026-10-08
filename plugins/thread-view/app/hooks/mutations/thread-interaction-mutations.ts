import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PendingInteraction } from "@bb/domain";
import type { ResolvePendingInteractionRequest } from "@bb/server-contract";
import { sdk } from "@bb/app-kit/lib/sdk";
import { isHostDisconnectedError } from "@bb/app-kit/lib/lifecycle-errors";
import { useEnvironment } from "@bb/app-kit/hooks/queries/environment-queries";
import { useHosts } from "@bb/app-kit/hooks/queries/host-queries";
import { qk } from "@bb/app-kit/hooks/queries/query-keys";
import { refresh, STREAM } from "@bb/app-kit/hooks/queries/refresh";
import { useThread } from "@bb/app-kit/hooks/queries/thread-queries";

function useIsThreadHostConnected(threadId: string): boolean {
  const environmentId = useThread(threadId).data?.environmentId;
  const hostId = useEnvironment(environmentId).data?.hostId;
  const hosts = useHosts({ enabled: hostId !== undefined }).data;
  return (
    hosts?.some((host) => host.id === hostId && host.status === "connected") ??
    false
  );
}

export function useResolveThreadPendingInteraction(threadId: string) {
  const client = useQueryClient();
  const isHostConnected = useIsThreadHostConnected(threadId);
  const mutation = useMutation({
    meta: {
      errorMessage: "Failed to resolve pending interaction.",
      showErrorToast: false,
    },
    mutationFn: (args: {
      threadId: string;
      interactionId: string;
      resolution: ResolvePendingInteractionRequest;
    }): Promise<PendingInteraction> => sdk.threads.interactions.resolve(args),
    onSuccess: (interaction, { threadId }) => {
      const open =
        interaction.status === "pending" || interaction.status === "resolving";
      client.setQueryData<PendingInteraction[]>(
        qk.interactions(threadId),
        (interactions) =>
          interactions?.flatMap((current) => {
            if (current.id !== interaction.id) return [current];
            return open ? [interaction] : [];
          }),
      );
      refresh(client, qk.interactions(threadId));
      refresh(client, qk.timeline(threadId), STREAM);
    },
  });
  const isStaleHostError =
    isHostConnected && isHostDisconnectedError(mutation.error);
  return { ...mutation, error: isStaleHostError ? null : mutation.error };
}
