import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query";
import type { Host } from "@bb/domain";
import { sdk } from "@/lib/sdk";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import type { QueryOptions } from "./query-helpers";
import { qk } from "./query-keys";

export function useHosts(
  options?: QueryOptions & { includeCreating?: boolean },
) {
  const includeCreating = options?.includeCreating ?? false;
  return useQuery({
    queryKey: qk.hosts(includeCreating),
    queryFn: ({ signal }) => sdk.hosts.list({ signal, includeCreating }),
    enabled: options?.enabled ?? true,
    staleTime: 60_000,
  });
}

export function selectHosts(
  hosts: readonly Host[] | undefined,
  scope: "persistent" | "all",
): Host[] {
  return (hosts ?? []).filter(
    (host) => scope === "all" || host.type !== "ephemeral",
  );
}

export function selectPrimaryHost(
  hosts: readonly Host[] | undefined,
  primaryHostId: string | null,
): Host | null {
  const available = selectHosts(hosts, "persistent");
  if (primaryHostId !== null) {
    return available.find((host) => host.id === primaryHostId) ?? null;
  }
  const connected = available.find((host) => host.status === "connected");
  return connected ?? available[0] ?? null;
}

export function usePrimaryHost(options?: QueryOptions): Host | null {
  const { data: hosts } = useHosts(options);
  const primaryHostId = useSystemConfig(options).data?.primaryHostId ?? null;
  return selectPrimaryHost(hosts, primaryHostId);
}

export function useHostDirectory(hostId: string | null, path: string | null) {
  return useQuery({
    queryKey: qk.hostDirectory(hostId, path),
    queryFn: hostId
      ? ({ signal }) =>
          sdk.hosts.directory({ hostId, ...(path ? { path } : {}), signal })
      : skipToken,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

type HostPathExistence = Record<string, boolean>;

export function useHostPathExistence(
  hostId: string | null,
  paths: readonly string[],
): HostPathExistence {
  const sortedPaths = [...new Set(paths)].sort();
  const query = useQuery({
    queryKey: qk.hostPaths(hostId, sortedPaths),
    queryFn:
      hostId !== null && sortedPaths.length > 0
        ? async ({ signal }) => {
            const request = { hostId, paths: sortedPaths, signal };
            return (await sdk.hosts.pathsExist(request)).existence;
          }
        : skipToken,
    staleTime: 10_000,
  });
  return query.data ?? {};
}

export function isHostPathMissing(
  existence: HostPathExistence,
  path: string | null | undefined,
): boolean {
  return path != null && existence[path] === false;
}
