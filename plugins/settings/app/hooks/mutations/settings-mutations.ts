import { callOp, settings } from "@bb/plugin/app";
import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  applyAppKeybindingOverrides,
  type AppKeybindingOverrides,
  type AppSettings,
  type AppTheme,
} from "@bb/domain";
import type { SystemConfigResponse } from "@bb/server-contract";
import { qk } from "@bb/app-kit/hooks/queries/query-keys";
import { ANY, filterFor } from "@bb/app-kit/hooks/queries/refresh";

interface QueryClientArg {
  queryClient: QueryClient;
}

export function invalidateSystemConfig({
  queryClient,
}: QueryClientArg): Promise<void[]> {
  return Promise.all(
    [qk.system(), qk.timeline(ANY), qk.turnDetails(ANY)].map((queryKey) =>
      queryClient.invalidateQueries(filterFor(queryKey)),
    ),
  );
}

export function invalidateMachineEnvironment({
  queryClient,
}: QueryClientArg): void {
  void queryClient.invalidateQueries({ queryKey: qk.machineEnvironment() });
}

export function useUpdateGeneralSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorMessage: "Failed to update general settings." },
    mutationFn: (changes: AppSettings) =>
      callOp(settings.updateGeneral, { settings: changes }),
    onSuccess: () => invalidateSystemConfig({ queryClient }),
  });
}

export function useUpdateKeyboardSettings() {
  const queryClient = useQueryClient();
  const queryKey = qk.systemConfig();
  return useMutation({
    meta: { errorMessage: "Failed to update keyboard shortcuts." },
    mutationFn: (overrides: AppKeybindingOverrides) =>
      callOp(settings.updateKeyboard, { overrides }),
    onMutate: async (keybindingOverrides) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<SystemConfigResponse>(queryKey);
      queryClient.setQueryData<SystemConfigResponse>(
        queryKey,
        (config) =>
          config && {
            ...config,
            keybindings: applyAppKeybindingOverrides(
              config.defaultKeybindings,
              keybindingOverrides,
            ),
            keybindingOverrides,
          },
      );
      return previous;
    },
    onError: (_error, _overrides, previous) => {
      queryClient.setQueryData(queryKey, previous);
    },
    onSettled: () => invalidateSystemConfig({ queryClient }),
  });
}

export function useUpdateAppearance() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorMessage: "Failed to update appearance." },
    mutationFn: (selection: AppTheme) =>
      callOp(settings.updateAppearance, selection),
    onSuccess: () => invalidateSystemConfig({ queryClient }),
  });
}
