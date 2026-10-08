import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import type { ProjectWithThreadsResponse } from "@bb/server-contract";
import { readProjectBranchOptions } from "../../lib/project-branch-options";
import { sdk } from "../../lib/sdk";
import { useDebouncedValue } from "../useDebouncedValue";
import type { QueryOptions } from "./query-helpers";
import { qk } from "./query-keys";

interface ProjectRouting {
  environmentId: string | null;
  hostId: string | null;
}

function routed({ environmentId, hostId }: ProjectRouting) {
  if (environmentId !== null) return { environmentId };
  return hostId !== null ? { hostId } : {};
}

export function stripProjectThreads(
  project: ProjectWithThreadsResponse,
): Omit<ProjectWithThreadsResponse, "threads"> {
  const { threads: _threads, ...rest } = project;
  return rest;
}

export function useProjectSourceBranches(
  projectId: string | undefined,
  hostId: string | null,
  options?: QueryOptions & {
    limit?: number;
    query?: string;
    selectedBranch?: string;
  },
) {
  const query = useDebouncedValue(options?.query?.trim() ?? "", 120);
  const selectedBranch = options?.selectedBranch?.trim() ?? "";
  const limit = options?.limit ?? 50;
  const fromRemote = useRef(false);
  const stable = { hostId, limit, selectedBranch };
  const result = useQuery({
    queryKey: qk.projectBranches(projectId, { ...stable, query }),
    queryFn: ({ signal }) => {
      const read = fromRemote.current
        ? sdk.projects.branches
        : readProjectBranchOptions;
      fromRemote.current = false;
      return read({
        projectId: projectId ?? "",
        hostId: hostId ?? "",
        ...(query ? { query } : {}),
        ...(selectedBranch ? { selectedBranch } : {}),
        limit: String(limit),
        signal,
      });
    },
    enabled: (options?.enabled ?? true) && Boolean(projectId && hostId),
    staleTime: 30_000,
    placeholderData: (previous, previousQuery) => {
      const [, id, , args] = previousQuery?.queryKey ?? [];
      const same = args as Partial<typeof stable> | undefined;
      return id === projectId &&
        same?.hostId === hostId &&
        same.limit === limit &&
        same.selectedBranch === selectedBranch
        ? previous
        : undefined;
    },
  });
  const { refetch } = result;
  const refreshFromRemote = async (): Promise<void> => {
    fromRemote.current = true;
    await refetch();
  };
  return { ...result, refreshFromRemote };
}

export function useProjectPromptHistory(
  projectId: string | undefined,
  options?: QueryOptions,
) {
  return useQuery({
    queryKey: qk.projectPromptHistory(projectId),
    queryFn: ({ signal }) =>
      sdk.projects.promptHistory({ projectId: projectId ?? "", signal }),
    enabled: (options?.enabled ?? true) && Boolean(projectId),
    staleTime: 10_000,
  });
}

export function useProjectPathSuggestions(
  args: ProjectRouting & {
    projectId: string | undefined;
    query: string | null;
    limit?: number;
    includeFiles: boolean;
    includeDirectories: boolean;
  },
) {
  const { projectId, limit = 8, includeFiles, includeDirectories } = args;
  const query = args.query?.trim() ?? "";
  const route = routed(args);
  const filter = { ...route, query, limit, includeFiles, includeDirectories };
  return useQuery({
    queryKey: qk.projectPaths(projectId, filter),
    queryFn: ({ signal }) =>
      sdk.projects.paths({
        projectId: projectId ?? "",
        query,
        limit: String(limit),
        includeFiles: includeFiles ? "true" : "false",
        includeDirectories: includeDirectories ? "true" : "false",
        signal,
        ...route,
      }),
    enabled: Boolean(projectId) && query.length > 0,
    retry: false,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

export function useProjectCommands(
  args: ProjectRouting & {
    projectId: string | undefined;
    providerId: string | undefined;
  },
  options?: QueryOptions,
) {
  const { projectId, providerId } = args;
  const route = routed(args);
  return useQuery({
    queryKey: qk.projectCommands(projectId, { ...route, providerId }),
    queryFn: ({ signal }) =>
      sdk.projects.commands({
        projectId: projectId ?? "",
        provider: providerId ?? "",
        signal,
        ...route,
      }),
    enabled: (options?.enabled ?? true) && Boolean(projectId && providerId),
    retry: false,
    staleTime: 0,
  });
}
