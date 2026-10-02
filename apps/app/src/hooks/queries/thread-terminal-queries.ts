import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CloseTerminalRequest,
  CreateTerminalRequest,
  TerminalListResponse,
  TerminalSession,
  UpdateTerminalRequest,
} from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import {
  applyTerminalSessionClose,
  applyTerminalSessionUpsert,
} from "../cache-owners/terminal-cache-owner";
import { terminalsQueryKey, type TerminalQueryScope } from "./query-keys";
import { requireEnabledQueryArg, type QueryOptions } from "./query-helpers";
import { REALTIME_OWNED_NO_FOCUS_QUERY_POLICY } from "./query-policies";

type ScopedCreateTerminalRequest = Omit<CreateTerminalRequest, "target">;

interface CreateEnvironmentTerminalMutationRequest extends ScopedCreateTerminalRequest {
  environmentId: string;
}

interface RenameTerminalMutationRequest extends UpdateTerminalRequest {
  terminalId: string;
}

interface CloseTerminalMutationRequest {
  mode: CloseTerminalRequest["mode"];
  terminalId: string;
}

interface CloseEnvironmentTerminalMutationRequest extends CloseTerminalMutationRequest {
  environmentId: string;
}

export function useTerminals(
  scope: TerminalQueryScope | null | undefined,
  options?: QueryOptions,
) {
  return useQuery<TerminalListResponse>({
    queryKey: terminalsQueryKey(
      scope ?? { kind: "host_path", hostId: "__disabled__" },
    ),
    queryFn: ({ signal }) =>
      sdk.terminals.list({
        scope: requireEnabledQueryArg({
          value: scope,
          hookName: "useTerminals",
          argName: "terminal scope",
        }),
        signal,
      }),
    enabled:
      (options?.enabled ?? true) && scope !== null && scope !== undefined,
    ...REALTIME_OWNED_NO_FOCUS_QUERY_POLICY,
  });
}

export function useEnvironmentTerminals(id: string, options?: QueryOptions) {
  return useTerminals(
    id ? { kind: "environment", environmentId: id } : null,
    options,
  );
}

export function useCreateTerminal() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to start terminal.",
      lifecycleOperation: "open_terminal",
    },
    mutationFn: ({ target, ...request }: CreateTerminalRequest) =>
      sdk.terminals.create({ ...request, scope: target }),
    onSuccess: (session: TerminalSession) => {
      applyTerminalSessionUpsert({ queryClient, session });
    },
  });
}

export function useCreateEnvironmentTerminal() {
  const createTerminal = useCreateTerminal();

  return {
    ...createTerminal,
    mutate: (
      { environmentId, ...request }: CreateEnvironmentTerminalMutationRequest,
      options?: Parameters<typeof createTerminal.mutate>[1],
    ) =>
      createTerminal.mutate(
        {
          ...request,
          target: { kind: "environment", environmentId },
        },
        options,
      ),
    mutateAsync: ({
      environmentId,
      ...request
    }: CreateEnvironmentTerminalMutationRequest) =>
      createTerminal.mutateAsync({
        ...request,
        target: { kind: "environment", environmentId },
      }),
  };
}

export function useRenameTerminal() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to rename terminal.",
    },
    mutationFn: ({ terminalId, ...request }: RenameTerminalMutationRequest) =>
      sdk.terminals.rename({ terminalId, ...request }),
    onSuccess: (session: TerminalSession) => {
      applyTerminalSessionUpsert({ queryClient, session });
    },
  });
}

export function useCloseTerminal() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to close terminal.",
    },
    mutationFn: ({ mode, terminalId }: CloseTerminalMutationRequest) =>
      sdk.terminals.close({ mode, terminalId }),
    onSuccess: (session: TerminalSession, variables) => {
      applyTerminalSessionClose({
        queryClient,
        session,
        terminalId: variables.terminalId,
      });
    },
  });
}

export function useCloseEnvironmentTerminal() {
  const closeTerminal = useCloseTerminal();

  return {
    ...closeTerminal,
    mutate: (
      {
        environmentId: _environmentId,
        ...request
      }: CloseEnvironmentTerminalMutationRequest,
      options?: Parameters<typeof closeTerminal.mutate>[1],
    ) => closeTerminal.mutate(request, options),
    mutateAsync: ({
      environmentId: _environmentId,
      ...request
    }: CloseEnvironmentTerminalMutationRequest) =>
      closeTerminal.mutateAsync(request),
  };
}
