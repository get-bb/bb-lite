import { callOp, terminals } from "@bb/plugin/app";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CloseTerminalRequest,
  CreateTerminalRequest,
  TerminalListResponse,
  TerminalSession,
  UpdateTerminalRequest,
} from "@bb/server-contract";
import {
  applyTerminalSessionClose,
  applyTerminalSessionUpsert,
} from "../cache-owners/terminal-cache-owner";
import { terminalsQueryKey, type TerminalQueryScope } from "./query-keys";
import { requireEnabledQueryArg, type QueryOptions } from "./query-helpers";
import { REALTIME_OWNED_NO_FOCUS_QUERY_POLICY } from "./query-policies";

interface RenameTerminalMutationRequest extends UpdateTerminalRequest {
  terminalId: string;
}

interface CloseTerminalMutationRequest {
  mode: CloseTerminalRequest["mode"];
  terminalId: string;
}

function terminalListQuery(scope: TerminalQueryScope) {
  if (scope.kind === "thread") return { threadId: scope.threadId };
  if (scope.kind === "environment") {
    return { environmentId: scope.environmentId };
  }
  const { hostId, cwd } = scope;
  return { hostId, ...(cwd === undefined ? {} : { cwd }) };
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
      callOp(
        terminals.list,
        terminalListQuery(
          requireEnabledQueryArg({
            value: scope,
            hookName: "useTerminals",
            argName: "terminal scope",
          }),
        ),
        { signal },
      ),
    enabled:
      (options?.enabled ?? true) && scope !== null && scope !== undefined,
    ...REALTIME_OWNED_NO_FOCUS_QUERY_POLICY,
  });
}

export function useCreateTerminal() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to start terminal.",
      lifecycleOperation: "open_terminal",
    },
    mutationFn: ({ target, ...request }: CreateTerminalRequest) =>
      callOp(terminals.create, { ...request, target }),
    onSuccess: (session: TerminalSession) => {
      applyTerminalSessionUpsert({ queryClient, session });
    },
  });
}

export function useRenameTerminal() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to rename terminal.",
    },
    mutationFn: ({ terminalId, ...request }: RenameTerminalMutationRequest) =>
      callOp(terminals.update, { terminalId, ...request }),
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
      callOp(terminals.close, { mode, terminalId, reason: "user" }),
    onSuccess: (session: TerminalSession, variables) => {
      applyTerminalSessionClose({
        queryClient,
        session,
        terminalId: variables.terminalId,
      });
    },
  });
}
