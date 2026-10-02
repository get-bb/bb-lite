import { queryOptions, useQuery } from "@tanstack/react-query";
import {
  readCachedSidebarBootstrap,
  writeCachedSidebarBootstrap,
} from "@/lib/sidebar-bootstrap-cache";
import { sdk } from "@/lib/sdk";
import type { QueryOptions } from "./query-helpers";
import { qk } from "./query-keys";

const sidebarNavigationQueryOptions = queryOptions({
  queryKey: qk.sidebar(),
  queryFn: async ({ signal }) => {
    const response = await sdk.projects.sidebarBootstrap({ signal });
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
