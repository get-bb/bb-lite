import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Host, PermissionMode } from "@bb/domain";
import { apiClient } from "@/lib/api-server";
import { request } from "@/lib/api";
import { sdk } from "@/lib/sdk";
import { qk } from "../queries/query-keys";

function useHostMutation<TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
) {
  const client = useQueryClient();
  return useMutation({
    meta: { showErrorToast: false },
    mutationFn,
    onSuccess: () => client.invalidateQueries({ queryKey: qk.hosts() }),
  });
}

export function useRenameHost() {
  return useHostMutation((args: { hostId: string; name: string }) =>
    sdk.hosts.update(args),
  );
}

export function useRemoveHost() {
  return useHostMutation(async (hostId: string) => {
    await sdk.hosts.delete({ hostId });
  });
}

export function useUpdateHostPermissionCeiling() {
  return useHostMutation(
    (args: { hostId: string; maxPermissionMode: PermissionMode }) =>
      request<Host>(
        apiClient.hosts[":id"]["permission-ceiling"].$patch({
          param: { id: args.hostId },
          json: { maxPermissionMode: args.maxPermissionMode },
        }),
      ),
  );
}

export function useReconnectHost() {
  return useMutation({
    meta: { showErrorToast: false },
    mutationFn: (hostId: string) =>
      sdk.hosts.experimental_reconnect({ hostId }),
  });
}
