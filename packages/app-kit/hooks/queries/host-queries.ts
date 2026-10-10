import { callOp, machines } from "@bb/plugin/app";
import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query";
import type { Host } from "@bb/domain";
import { useSystemConfig } from "./system-queries";
import { isHostUsable } from "../../lib/machine-access";
import type { QueryOptions } from "./query-helpers";
import { qk } from "./query-keys";

export function useHosts(
  options?: QueryOptions & { includeCreating?: boolean },
) {
  const includeCreating = options?.includeCreating ?? false;
  return useQuery({
    queryKey: qk.hosts(includeCreating),
    queryFn: ({ signal }) =>
      callOp(machines.list, { includeCreating }, { signal }),
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
  const usable = available.filter(isHostUsable);
  const firstUsable =
    usable.find((host) => host.status === "connected") ?? usable[0] ?? null;
  if (primaryHostId !== null) {
    const primary = available.find((host) => host.id === primaryHostId);
    if (primary === undefined) return null;
    return isHostUsable(primary) ? primary : firstUsable;
  }
  return firstUsable;
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
          callOp(
            machines.directory,
            { hostId, ...(path ? { path } : {}) },
            { signal },
          )
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
            const request = { hostId, paths: sortedPaths };
            const found = await callOp(machines.pathsExist, request, {
              signal,
            });
            return found.existence;
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
