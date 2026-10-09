import { callOp, server, sessions, settings } from "@bb/plugin/app";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  availableModelSchema,
  permissionModeValues,
  providerInfoSchema,
  type ProviderInfo,
  type ProviderModelCatalogScope,
} from "@bb/domain";
import type {
  SystemExecutionOptionsResponse,
  SystemProvidersQuery,
  UiPreferencesResponse,
} from "@bb/server-contract";
import { z } from "zod";
import { createLastKnownCache } from "../../lib/last-known-cache";
import type { QueryOptions } from "./query-helpers";
import { qk } from "./query-keys";

type ProviderRouting =
  | { environmentId: string; hostId?: never }
  | { environmentId?: never; hostId: string }
  | { environmentId?: never; hostId?: never };

export function useSystemConfig(options?: QueryOptions) {
  return useQuery({
    queryKey: qk.systemConfig(),
    queryFn: ({ signal }) => callOp(server.config, {}, { signal }),
    enabled: options?.enabled ?? true,
    staleTime: 60_000,
  });
}

export function useUiPreferences(options?: QueryOptions) {
  return useQuery({
    queryKey: qk.uiPreferences(),
    queryFn: ({ signal }) => callOp(settings.uiPreferences, {}, { signal }),
    enabled: options?.enabled ?? true,
    staleTime: 60_000,
  });
}

export function getCachedUiPreferences(
  client: QueryClient,
): UiPreferencesResponse | undefined {
  return client.getQueryData<UiPreferencesResponse>(qk.uiPreferences());
}

export function setCachedUiPreferences(
  client: QueryClient,
  response: UiPreferencesResponse,
): void {
  client.setQueryData(qk.uiPreferences(), response);
}

export function invalidateCachedUiPreferences(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: qk.uiPreferences() });
}

export function useSystemProviderCatalog() {
  return useQuery({
    queryKey: qk.providerCatalog(),
    queryFn: () => callOp(sessions.providerCatalog, {}),
  });
}

const lastKnownProviders = createLastKnownCache({
  prefix: "bb.provider-list",
  version: "2",
  schema: z.array(providerInfoSchema),
  maxEntries: 16,
});
const lastKnownModels = createLastKnownCache({
  prefix: "bb.model-catalog",
  version: "1",
  schema: z.object({
    models: z.array(availableModelSchema),
    selectedOnlyModels: z.array(availableModelSchema),
  }),
  maxEntries: 8,
});

export function useSystemProviders(
  args: QueryOptions &
    ProviderRouting &
    Pick<SystemProvidersQuery, "capability"> = {},
) {
  const { capability, enabled = true, ...routing } = args;
  const cacheKey = lastKnownProviders.key(
    routing.environmentId,
    routing.hostId,
  );
  return useQuery({
    queryKey: qk.systemProviders({ capability, ...routing }),
    queryFn: async ({ signal }) => {
      const providers = await callOp(
        sessions.providers,
        { ...routing, ...(capability ? { capability } : {}) },
        { signal },
      );
      if (!capability) lastKnownProviders.write(cacheKey, providers);
      return providers;
    },
    enabled,
    staleTime: 60_000,
    placeholderData: () => {
      const eligible = lastKnownProviders
        .read(cacheKey)
        ?.filter((provider) => !capability || provider.maintenance[capability]);
      return eligible?.length ? eligible : undefined;
    },
  });
}

export function useKnownProviderModelCatalogScope(
  providerId: string,
): ProviderModelCatalogScope | undefined {
  const client = useQueryClient();
  const cached = [
    ...client.getQueriesData<SystemExecutionOptionsResponse>({
      queryKey: qk.executionOptions(),
    }),
    ...client.getQueriesData<ProviderInfo[]>({
      queryKey: qk.systemProviders(),
    }),
  ];
  for (const [, data] of cached) {
    const providers = Array.isArray(data) ? data : data?.providers;
    const provider = providers?.find(({ id }) => id === providerId);
    const scope = provider?.capabilities.modelCatalogScope;
    if (scope !== undefined) return scope;
  }
  return undefined;
}

export function useSystemExecutionOptions(
  args: {
    enabled?: boolean;
    environmentId?: string;
    hostId?: string;
    providerId?: string;
  } = {},
) {
  const { enabled = true, environmentId, hostId, providerId } = args;
  const route = { environmentId, hostId };
  const providersKey = lastKnownProviders.key(environmentId, hostId);
  const modelsKey = lastKnownModels.key(environmentId, hostId, providerId);
  return useQuery({
    queryKey: qk.executionOptions(route, providerId),
    queryFn: async ({ signal }) => {
      const request = { ...route, providerId };
      const response = await callOp(sessions.executionOptions, request, {
        signal,
      });
      const { models, modelLoadError, providers, selectedOnlyModels } =
        response;
      lastKnownProviders.write(providersKey, providers);
      if (modelLoadError === null) {
        lastKnownModels.write(modelsKey, { models, selectedOnlyModels });
      }
      return response;
    },
    enabled,
    staleTime: 60_000,
    placeholderData: (previous, previousQuery) => {
      const sameRoute =
        JSON.stringify(previousQuery?.queryKey[2]) === JSON.stringify(route);
      const providers =
        (sameRoute ? previous?.providers : undefined) ??
        lastKnownProviders.read(providersKey);
      const known =
        providerId === undefined ||
        providers?.some((provider) => provider.id === providerId);
      if (!providers?.length || !known) return undefined;
      const catalog = lastKnownModels.read(modelsKey);
      return {
        providers,
        models: catalog?.models ?? [],
        selectedOnlyModels: catalog?.selectedOnlyModels ?? [],
        permissionCeiling: permissionModeValues[0],
        modelLoadError: null,
      };
    },
  });
}
