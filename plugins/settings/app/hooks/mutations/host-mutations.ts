import { callOp, machines } from "@bb/plugin/app";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { MachineSharing, PermissionMode } from "@bb/domain";
import { qk } from "@bb/app-kit/hooks/queries/query-keys";

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
    callOp(machines.update, args),
  );
}

export function useRemoveHost() {
  return useHostMutation(async (hostId: string) => {
    await callOp(machines.delete, { hostId });
  });
}

export function useUpdateHostPermissionCeiling() {
  return useHostMutation(
    (args: { hostId: string; maxPermissionMode: PermissionMode }) =>
      callOp(machines.updatePermissionCeiling, args),
  );
}

export function useSetHostSharing() {
  return useHostMutation((args: { hostId: string; sharing: MachineSharing }) =>
    callOp(machines.updateSharing, args),
  );
}

export function useReconnectHost() {
  return useMutation({
    meta: { showErrorToast: false },
    mutationFn: (hostId: string) =>
      callOp(machines.createReconnectCommand, { hostId }),
  });
}
