import { queryOptions, useQuery } from "@tanstack/react-query";
import {
  readCachedSidebarBootstrap,
  writeCachedSidebarBootstrap,
} from "../../lib/sidebar-bootstrap-cache";
import type { SidebarBootstrapResponse } from "@bb/server-contract";
import { request, requestOptions } from "../../lib/api";
import { apiClient } from "../../lib/api-server";
import type { QueryOptions } from "./query-helpers";
import { qk } from "./query-keys";

const bootstrap = apiClient["sidebar-bootstrap"];
const sidebarNavigationQueryOptions = queryOptions({
  queryKey: qk.sidebar(),
  queryFn: async ({ signal }) => {
    const pending = bootstrap.$get(undefined, requestOptions(signal));
    const response = await request<SidebarBootstrapResponse>(pending);
    writeCachedSidebarBootstrap(response);
    return response;
  },
  staleTime: Infinity,
  placeholderData: () => readCachedSidebarBootstrap() ?? undefined,
});

export function useSidebarNavigation(options?: QueryOptions) {
  return useQuery({
    ...sidebarNavigationQueryOptions,
    enabled: options?.enabled ?? true,
  });
}

export function useProjectDisplayName(
  projectId: string | undefined,
): string | undefined {
  const { data } = useSidebarNavigation({ enabled: Boolean(projectId) });
  const projects = data ? [data.personalProject, ...data.projects] : [];
  return projects.find((project) => project.id === projectId)?.name;
}
