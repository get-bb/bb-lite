import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { EnvironmentActionResponse } from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import type { RequestEnvironmentActionMutationRequest } from "./mutation-request-types";
import { bumpDiffPatchEvictionGeneration } from "../cache-owners/environment-diff-patch-cache-owner";
import { environmentDiffPatchQueryKeyPrefix, qk } from "../queries/query-keys";

function refreshEnvironment(client: QueryClient, environmentId: string) {
  bumpDiffPatchEvictionGeneration(environmentId);
  client.removeQueries({
    queryKey: environmentDiffPatchQueryKeyPrefix(environmentId),
  });
  for (const queryKey of qk.environmentState(environmentId)) {
    void client.invalidateQueries({ queryKey });
  }
}

export function useRequestEnvironmentAction() {
  const client = useQueryClient();
  return useMutation({
    meta: {
      errorMessage: "Failed to run environment action.",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
    }: RequestEnvironmentActionMutationRequest): Promise<EnvironmentActionResponse> =>
      sdk.environments.commit({ environmentId: id }),
    onSuccess: (_response, { id }) => refreshEnvironment(client, id),
  });
}

export function useUpdateEnvironment() {
  const client = useQueryClient();
  return useMutation({
    meta: {
      errorMessage: "Failed to update environment.",
      showErrorToast: false,
    },
    mutationFn: (request: { id: string; mergeBaseBranch: string | null }) =>
      sdk.environments.update({
        environmentId: request.id,
        mergeBaseBranch: request.mergeBaseBranch,
      }),
    onSuccess: (environment) => {
      client.setQueryData(qk.environment(environment.id), environment);
      refreshEnvironment(client, environment.id);
    },
  });
}
