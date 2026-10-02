import type { QueryKey } from "@tanstack/react-query";
import type { Environment, Host } from "@bb/domain";
import type {
  SystemConfigResponse,
  SystemProviderCatalogEntry,
} from "@bb/server-contract";
import {
  allEnvironmentDiffFilesQueryKeyPrefix,
  allEnvironmentDiffPatchQueryKeyPrefix,
  allEnvironmentFilePreviewQueryKeyPrefix,
  allEnvironmentMergeBaseBranchesQueryKeyPrefix,
  allEnvironmentQueryKeyPrefix,
  allEnvironmentWorkStatusQueryKeyPrefix,
  allHostQueryKeyPrefix,
  allMachineEnvironmentQueryKeyPrefix,
  allProjectPathsQueryKeyPrefix,
  allSystemExecutionOptionsQueryKeyPrefix,
  allSystemProvidersQueryKeyPrefix,
  allSystemThemesQueryKeyPrefix,
  allTerminalsQueryKeyPrefix,
  allThreadDetailBootstrapQueryKeyPrefix,
  allThreadHostFilePreviewQueryKeyPrefix,
  allThreadPendingInteractionsQueryKeyPrefix,
  allThreadQueuedMessagesQueryKeyPrefix,
  allThreadQueryKeyPrefix,
  allThreadStorageFilePreviewQueryKeyPrefix,
  allThreadStorageFilesQueryKeyPrefix,
  allThreadStorageLocationsQueryKeyPrefix,
  allThreadStoragePathsQueryKeyPrefix,
  allThreadTimelineQueryKeyPrefix,
  allThreadTimelineTurnSummaryDetailsQueryKeyPrefix,
  environmentQueryKey,
  hostPathExistenceQueryKeyPrefix,
  hostsQueryKey,
  projectsQueryKey,
  sidebarNavigationQueryKey,
  systemConfigQueryKey,
  systemProviderCatalogQueryKey,
  threadPromptHistoryQueryKeyPrefix,
  threadSearchQueryKeyPrefix,
  threadsQueryKey,
} from "../queries/query-keys";
import { allThreadDefaultExecutionOptionsQueryKeyPrefix } from "../queries/thread-default-execution-options-query";
import type { QueryClientArg } from "../cache-effect-types";
import { clearCachedModelCatalogs } from "@/lib/model-catalog-cache";
import { bumpAllDiffPatchEvictionGenerations } from "./environment-diff-patch-cache-owner";
import { invalidatePluginList } from "./plugin-cache-owner";
import {
  invalidateQueryKeys,
  refetchFailedActiveQueryKeys,
} from "./cache-effect-utils";

interface SystemExecutionOptionsInvalidationArgs extends QueryClientArg {
  hostId: string;
}

interface ServerReconnectInvalidationArgs extends QueryClientArg {
  disconnectedAt: number;
}

export function invalidateRealtimeQueriesAfterServerReconnect({
  disconnectedAt,
  queryClient,
}: ServerReconnectInvalidationArgs): void {
  for (const queryKey of getServerReconnectInvalidationQueryKeys()) {
    void queryClient.invalidateQueries(
      {
        queryKey,
        predicate: (query) => query.state.dataUpdatedAt < disconnectedAt,
      },
      { cancelRefetch: false },
    );
  }
  bumpAllDiffPatchEvictionGenerations();
  queryClient.removeQueries({
    queryKey: allEnvironmentDiffPatchQueryKeyPrefix(),
  });
}

export function refetchErroredRealtimeQueriesOnInitialConnect({
  queryClient,
}: QueryClientArg): void {
  refetchFailedActiveQueryKeys({
    queryClient,
    queryKeys: getServerReconnectInvalidationQueryKeys(),
  });
}

interface InitialConnectInvalidationArgs extends QueryClientArg {
  connectedAt: number;
}

export function invalidateRealtimeQueriesFetchedBeforeInitialConnect({
  connectedAt,
  queryClient,
}: InitialConnectInvalidationArgs): void {
  for (const queryKey of getServerReconnectInvalidationQueryKeys()) {
    queryClient.invalidateQueries({
      queryKey,
      predicate: (query) =>
        query.state.dataUpdatedAt !== 0 &&
        query.state.dataUpdatedAt < connectedAt,
    });
  }
}

export function invalidateSystemConfig({ queryClient }: QueryClientArg): void {
  invalidateQueryKeys({
    queryClient,
    queryKeys: [systemConfigQueryKey(), allSystemThemesQueryKeyPrefix()],
  });
}

export function invalidateMachineEnvironment({
  queryClient,
}: QueryClientArg): void {
  invalidateQueryKeys({
    queryClient,
    queryKeys: [allMachineEnvironmentQueryKeyPrefix()],
  });
}

export async function applyProviderAvailabilityChange({
  queryClient,
  catalog,
}: QueryClientArg & { catalog: SystemProviderCatalogEntry[] }): Promise<void> {
  queryClient.setQueryData(systemProviderCatalogQueryKey(), catalog);
  await Promise.all([
    invalidateSystemProviders({ queryClient }),
    queryClient.invalidateQueries({
      queryKey: allSystemExecutionOptionsQueryKeyPrefix(),
    }),
    queryClient.invalidateQueries({ queryKey: systemConfigQueryKey() }),
    invalidatePluginList({ queryClient }),
  ]);
}

export function invalidateSystemProviders({
  queryClient,
}: QueryClientArg): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: allSystemProvidersQueryKeyPrefix(),
  });
}

export function invalidateSystemExecutionOptions({
  hostId,
  queryClient,
}: SystemExecutionOptionsInvalidationArgs): Promise<void> {
  const primaryHostId =
    queryClient.getQueryData<SystemConfigResponse>(systemConfigQueryKey())
      ?.primaryHostId ?? null;
  return queryClient.invalidateQueries({
    queryKey: allSystemExecutionOptionsQueryKeyPrefix(),
    predicate: (query) => {
      const [, environmentId, routedHostId] = query.queryKey;
      if (typeof routedHostId === "string") return routedHostId === hostId;
      if (typeof environmentId === "string") {
        const environment = queryClient.getQueryData<Environment>(
          environmentQueryKey(environmentId),
        );
        return environment === undefined || environment.hostId === hostId;
      }
      return primaryHostId === null || primaryHostId === hostId;
    },
  });
}

export function invalidateGeneralSettingsDependencies({
  queryClient,
}: QueryClientArg): void {
  invalidateQueryKeys({
    queryClient,
    queryKeys: [
      systemConfigQueryKey(),
      allThreadTimelineQueryKeyPrefix(),
      allThreadTimelineTurnSummaryDetailsQueryKeyPrefix(),
    ],
  });
}

export function resetModelCatalogsAfterStreamerModeChange({
  queryClient,
}: QueryClientArg): Promise<void> {
  clearCachedModelCatalogs();
  return queryClient.resetQueries({
    queryKey: allSystemExecutionOptionsQueryKeyPrefix(),
  });
}

function getServerReconnectInvalidationQueryKeys(): QueryKey[] {
  return [
    hostsQueryKey(),
    allHostQueryKeyPrefix(),
    projectsQueryKey(),
    sidebarNavigationQueryKey(),
    allProjectPathsQueryKeyPrefix(),
    threadsQueryKey(),
    threadSearchQueryKeyPrefix(),
    allThreadQueryKeyPrefix(),
    allThreadDetailBootstrapQueryKeyPrefix(),
    allThreadTimelineQueryKeyPrefix(),
    allThreadTimelineTurnSummaryDetailsQueryKeyPrefix(),
    allThreadQueuedMessagesQueryKeyPrefix(),
    threadPromptHistoryQueryKeyPrefix(),
    allThreadPendingInteractionsQueryKeyPrefix(),
    allThreadDefaultExecutionOptionsQueryKeyPrefix(),
    allThreadStorageFilesQueryKeyPrefix(),
    allThreadStorageLocationsQueryKeyPrefix(),
    allThreadStoragePathsQueryKeyPrefix(),
    allThreadStorageFilePreviewQueryKeyPrefix(),
    allThreadHostFilePreviewQueryKeyPrefix(),
    allTerminalsQueryKeyPrefix(),
    allEnvironmentQueryKeyPrefix(),
    allEnvironmentWorkStatusQueryKeyPrefix(),
    allEnvironmentMergeBaseBranchesQueryKeyPrefix(),
    allEnvironmentDiffFilesQueryKeyPrefix(),
    allEnvironmentFilePreviewQueryKeyPrefix(),
    hostPathExistenceQueryKeyPrefix(),
    allSystemProvidersQueryKeyPrefix(),
    allSystemExecutionOptionsQueryKeyPrefix(),
  ];
}

export function applyHostRenameResult({
  host,
  queryClient,
}: QueryClientArg & { host: Host }): void {
  queryClient.setQueryData<Host[]>(hostsQueryKey(), (hosts) =>
    hosts?.map((current) => (current.id === host.id ? host : current)),
  );
}
