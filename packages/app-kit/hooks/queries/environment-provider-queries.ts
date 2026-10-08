import { useQuery } from "@tanstack/react-query";
import type {
  SystemEnvironmentProvider,
  SystemEnvironmentProvidersQuery,
} from "@bb/server-contract";
import { systemEnvironmentProviderSchema } from "@bb/server-contract";
import { z } from "zod";
import { createLastKnownCache } from "../../lib/last-known-cache";
import { sdk } from "../../lib/sdk";
import { qk } from "./query-keys";

const NO_ENVIRONMENT_PROVIDERS: readonly SystemEnvironmentProvider[] = [];
const lastKnown = createLastKnownCache({
  prefix: "bb.environment-provider-list",
  version: "1",
  schema: z.array(systemEnvironmentProviderSchema),
  maxEntries: 64,
});

export function useSystemEnvironmentProviders(
  query: SystemEnvironmentProvidersQuery = {},
): { providers: readonly SystemEnvironmentProvider[] | undefined } {
  const cacheKey = lastKnown.key(query.projectId, query.hostId);
  const result = useQuery({
    queryKey: qk.environmentProviders(query),
    queryFn: async () => {
      const providers = await sdk.environments.listProviders(query);
      lastKnown.write(cacheKey, providers);
      return providers;
    },
    staleTime: 60 * 60_000,
    placeholderData: () => lastKnown.read(cacheKey) ?? undefined,
  });
  return { providers: result.isError ? NO_ENVIRONMENT_PROVIDERS : result.data };
}
