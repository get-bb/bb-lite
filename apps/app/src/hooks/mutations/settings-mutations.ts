import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  applyAppKeybindingOverrides,
  type AppKeybindingOverrides,
  type AppSettings,
  type AppThemeSelection,
} from "@bb/domain";
import type { SystemConfigResponse } from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import { qk } from "../queries/query-keys";

interface QueryClientArg {
  queryClient: QueryClient;
}

export function invalidateSystemConfig({
  queryClient,
}: QueryClientArg): Promise<void[]> {
  return Promise.all(
    qk
      .systemState()
      .map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}

export function invalidateMachineEnvironment({
  queryClient,
}: QueryClientArg): void {
  void queryClient.invalidateQueries({ queryKey: qk.machineEnvironments() });
}

export function useUpdateGeneralSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorMessage: "Failed to update general settings." },
    mutationFn: (settings: AppSettings) =>
      sdk.system.updateGeneralSettings(settings),
    onSuccess: () => invalidateSystemConfig({ queryClient }),
  });
}

export function useUpdateKeyboardSettings() {
  const queryClient = useQueryClient();
  const queryKey = qk.systemConfig();
  return useMutation({
    meta: { errorMessage: "Failed to update keyboard shortcuts." },
    mutationFn: (overrides: AppKeybindingOverrides) =>
      sdk.system.updateKeyboardSettings(overrides),
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
    mutationFn: (selection: AppThemeSelection) => sdk.theme.set(selection),
    onSuccess: () => invalidateSystemConfig({ queryClient }),
  });
}
