import { useMutation, useQueryClient } from "@tanstack/react-query";
import { sdk } from "@bb/app-kit/lib/sdk";
import { qk } from "@bb/app-kit/hooks/queries/query-keys";
import { invalidateSystemConfig } from "./settings-mutations";

export function useSetProviderEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorMessage: "Could not change provider availability." },
    mutationFn: (args: { providerId: string; enabled: boolean }) =>
      sdk.providers.setEnabled(args),
    onSuccess: (catalog) => {
      queryClient.setQueryData(qk.providerCatalog(), catalog);
      return invalidateSystemConfig({ queryClient });
    },
  });
}
