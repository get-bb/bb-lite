import { callOp, sessions } from "@bb/plugin/app";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { qk } from "@bb/app-kit/hooks/queries/query-keys";
import { invalidateSystemConfig } from "./settings-mutations";

export function useSetProviderEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorMessage: "Could not change provider availability." },
    mutationFn: (args: { providerId: string; enabled: boolean }) =>
      callOp(sessions.updateProvider, args),
    onSuccess: (catalog) => {
      queryClient.setQueryData(qk.providerCatalog(), catalog);
      return invalidateSystemConfig({ queryClient });
    },
  });
}
