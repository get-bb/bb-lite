import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { WorkspaceDiffTarget } from "@bb/domain";
import type { EnvironmentDiffArgs } from "@bb/sdk/browser";
import type {
  EnvironmentFilePreviewSource,
  FilePreview,
} from "@bb/client-core";
import { loadFilePreview } from "@/lib/api";
import { buildEnvironmentFileContentUrl } from "@/lib/file-content-urls";
import { sdk } from "@/lib/sdk";
import { useEnvironmentDetailRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { useDebouncedValue } from "../useDebouncedValue";
import type { QueryOptions } from "./query-helpers";
import { qk } from "./query-keys";

type EnvironmentId = string | null | undefined;

const HEAVY_GC_TIME_MS = 60_000;

export function useEnvironment(
  environmentId: EnvironmentId,
  options?: QueryOptions & { staleTime?: number },
) {
  const enabled = (options?.enabled ?? true) && Boolean(environmentId);
  useEnvironmentDetailRealtimeSubscription(environmentId, { enabled });
  return useQuery({
    queryKey: qk.environmentRecord(environmentId),
    queryFn: ({ signal }) =>
      sdk.environments.get({ environmentId: environmentId ?? "", signal }),
    enabled,
    staleTime: options?.staleTime,
  });
}

export function useEnvironmentWorkStatus(
  environmentId: EnvironmentId,
  mergeBaseBranch?: string,
  options?: QueryOptions,
) {
  const enabled = (options?.enabled ?? true) && Boolean(environmentId);
  useEnvironmentDetailRealtimeSubscription(environmentId, { enabled });
  return useQuery({
    queryKey: qk.environmentStatus(environmentId, mergeBaseBranch),
    queryFn: ({ signal }) =>
      sdk.environments.status({
        environmentId: environmentId ?? "",
        mergeBaseBranch,
        signal,
      }),
    enabled,
    refetchOnMount: "always",
    staleTime: 0,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === environmentId ? previous : undefined,
  });
}

export function useEnvironmentMergeBaseBranches(
  environmentId: string,
  options?: QueryOptions & {
    limit?: number;
    query?: string;
    selectedBranch?: string;
  },
) {
  const query = useDebouncedValue(options?.query?.trim() ?? "", 120);
  const selectedBranch = options?.selectedBranch?.trim() ?? "";
  const limit = options?.limit ?? 50;
  const stable = { limit, selectedBranch };
  return useQuery({
    queryKey: qk.environmentBranches(environmentId, { ...stable, query }),
    queryFn: ({ signal }) =>
      sdk.environments.diffBranches({
        environmentId,
        ...(query ? { query } : {}),
        ...(selectedBranch ? { selectedBranch } : {}),
        limit: String(limit),
        signal,
      }),
    enabled: (options?.enabled ?? true) && Boolean(environmentId),
    staleTime: 30_000,
    placeholderData: (previous, previousQuery) => {
      const [, id, , args] = previousQuery?.queryKey ?? [];
      const same = args as Partial<typeof stable> | undefined;
      return id === environmentId &&
        same?.limit === limit &&
        same.selectedBranch === selectedBranch
        ? previous
        : undefined;
    },
  });
}

export function useEnvironmentFilePreview(
  environmentId: EnvironmentId,
  path: string | null,
  source: EnvironmentFilePreviewSource | null,
  options?: QueryOptions,
) {
  return useQuery<FilePreview>({
    queryKey: qk.environmentFile(environmentId, path, source),
    queryFn: ({ signal }) => {
      if (!environmentId || !path || source === null) {
        throw new Error("File preview needs an environment, path and source");
      }
      const url = buildEnvironmentFileContentUrl(environmentId, source, path);
      const name = path.split("/").at(-1);
      return loadFilePreview({ name, path, url }, signal);
    },
    enabled:
      (options?.enabled ?? true) &&
      Boolean(environmentId && path) &&
      source !== null,
    gcTime: HEAVY_GC_TIME_MS,
  });
}

export function useEnvironmentPathSuggestions(args: {
  environmentId: EnvironmentId;
  query: string | null;
  limit?: number;
  includeFiles: boolean;
  includeDirectories: boolean;
}) {
  const { environmentId, limit = 8, includeFiles, includeDirectories } = args;
  const query = args.query?.trim() ?? "";
  const filter = { query, limit, includeFiles, includeDirectories };
  return useQuery({
    queryKey: qk.environmentPaths(environmentId, filter),
    queryFn: ({ signal }) =>
      sdk.environments.paths({
        environmentId: environmentId ?? "",
        query,
        limit: String(limit),
        includeFiles: includeFiles ? "true" : "false",
        includeDirectories: includeDirectories ? "true" : "false",
        signal,
      }),
    enabled: Boolean(environmentId) && query.length > 0,
    retry: false,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

function diffArgs(
  environmentId: string,
  target: WorkspaceDiffTarget,
): EnvironmentDiffArgs {
  switch (target.type) {
    case "uncommitted":
      return { environmentId, target: target.type };
    case "branch_committed":
    case "all":
      return {
        environmentId,
        mergeBaseBranch: target.mergeBaseBranch,
        target: target.type,
      };
    case "commit":
      return { environmentId, sha: target.sha, target: target.type };
  }
}

export function useEnvironmentDiffFiles(
  environmentId: string,
  options: QueryOptions & { target?: WorkspaceDiffTarget },
) {
  const { target } = options;
  const enabled =
    (options.enabled ?? true) && Boolean(environmentId) && target !== undefined;
  useEnvironmentDetailRealtimeSubscription(environmentId, { enabled });
  return useQuery({
    queryKey: qk.environmentDiffFiles(environmentId, target),
    queryFn: ({ signal }) => {
      if (target === undefined) throw new Error("Diff files need a target");
      return sdk.environments.diffFiles({
        ...diffArgs(environmentId, target),
        signal,
      });
    },
    enabled,
    refetchOnMount: "always",
    staleTime: 5_000,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === environmentId ? previous : undefined,
  });
}
