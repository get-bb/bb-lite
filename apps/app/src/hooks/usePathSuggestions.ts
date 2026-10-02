import { useMemo } from "react";
import type { WorkspacePathEntry } from "@bb/server-contract";
import { useEnvironmentPathSuggestions } from "./queries/environment-queries";
import { useProjectPathSuggestions } from "./queries/project-queries";
import { isProjectlessProjectId } from "@/lib/route-paths";
import { useDebouncedValue } from "./useDebouncedValue";

export const PATH_SUGGESTION_DEBOUNCE_MS = 120;

interface PathSuggestion {
  source: "workspace";
  entryKind: WorkspacePathEntry["kind"];
  path: string;
  name: string;
  score: number;
  positions: number[];
}

const NO_PATHS: readonly WorkspacePathEntry[] = [];

export function usePathSuggestions(args: {
  projectId: string | undefined;
  query: string | null;
  limit?: number;
  environmentId: string | null;
  hostId?: string | null;
  includeDirectories: boolean;
}) {
  const limit = args.limit ?? 8;
  const debounced = useDebouncedValue(args.query, PATH_SUGGESTION_DEBOUNCE_MS);
  const debouncedQuery = args.query === null ? null : debounced;
  const trimmedQuery = args.query?.trim() ?? "";
  const hasQuery = trimmedQuery.length > 0;
  const debouncedTrimmedQuery = debouncedQuery?.trim() ?? "";
  const isDebouncing = hasQuery && trimmedQuery !== debouncedTrimmedQuery;
  const source = args.environmentId
    ? "environment"
    : args.projectId && !isProjectlessProjectId(args.projectId)
      ? "project"
      : "none";
  const request = {
    query: debouncedQuery,
    limit: limit * 2,
    includeFiles: true,
    includeDirectories: args.includeDirectories,
  };
  const projectQuery = useProjectPathSuggestions({
    ...request,
    projectId: source === "project" ? args.projectId : undefined,
    environmentId: null,
    hostId: args.hostId ?? null,
  });
  const environmentQuery = useEnvironmentPathSuggestions({
    ...request,
    environmentId: source === "environment" ? args.environmentId : undefined,
  });
  const result = source === "environment" ? environmentQuery : projectQuery;
  const isEnabled = source !== "none" && debouncedTrimmedQuery.length > 0;
  const paths =
    hasQuery && source !== "none" ? (result.data?.paths ?? NO_PATHS) : NO_PATHS;

  const suggestions = useMemo<PathSuggestion[]>(
    () =>
      [...paths]
        .sort(
          (left, right) =>
            right.score - left.score ||
            Number(right.kind === "directory") -
              Number(left.kind === "directory"),
        )
        .slice(0, limit)
        .map(({ kind, path, name, score, positions }) => ({
          source: "workspace",
          entryKind: kind,
          path,
          name,
          score,
          positions,
        })),
    [limit, paths],
  );

  return {
    suggestions,
    isLoading:
      hasQuery &&
      suggestions.length === 0 &&
      (isDebouncing || (isEnabled && (result.isPending || result.isFetching))),
    isError: hasQuery && isEnabled && result.isError,
    isDebouncing,
  };
}
