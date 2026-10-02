import { useCallback, useMemo } from "react";
import type { WorkspaceGitOperation } from "@bb/domain";
import { useProjectSourceBranches } from "@/hooks/queries/project-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";

interface ProjectHostArgs {
  hostId: string | null;
  projectId: string | null;
}

export interface CheckoutState {
  isGit: boolean | null;
  unborn: boolean;
  detached: boolean;
  dirty: boolean;
  currentBranch: string | null;
  operation: WorkspaceGitOperation;
}

export function useProjectBranches({
  hostId,
  projectId,
  query,
}: ProjectHostArgs & { query: string }) {
  const navigation = useSidebarNavigation({
    enabled: hostId === null && projectId !== null,
  });
  const sources = navigation.data?.projects.find(
    (project) => project.id === projectId,
  )?.sources;
  const source =
    sources?.find(
      (source) => source.type === "local_path" && source.isDefault,
    ) ?? sources?.find((source) => source.type === "local_path");
  const branchHostId = hostId ?? source?.hostId ?? null;
  const enabled = branchHostId !== null && projectId !== null;
  const branchesQuery = useProjectSourceBranches(
    projectId ?? undefined,
    branchHostId,
    {
      enabled,
      query,
      selectedBranch: "",
    },
  );
  const refreshFromRemote = branchesQuery.refreshFromRemote;
  const refresh = useCallback(async () => {
    if (!enabled) return;
    await refreshFromRemote();
  }, [enabled, refreshFromRemote]);

  return useMemo(
    () => ({
      branches: enabled ? (branchesQuery.data?.branches ?? []) : [],
      remoteBranches: enabled ? (branchesQuery.data?.remoteBranches ?? []) : [],
      defaultWorktreeBaseBranch: enabled
        ? (branchesQuery.data?.defaultWorktreeBaseBranch ?? null)
        : null,
      isLoading: enabled && branchesQuery.isFetching,
      refresh,
    }),
    [
      branchesQuery.data?.branches,
      branchesQuery.data?.remoteBranches,
      branchesQuery.data?.defaultWorktreeBaseBranch,
      branchesQuery.isFetching,
      enabled,
      refresh,
    ],
  );
}

export function useCheckoutState({
  hostId,
  projectId,
}: ProjectHostArgs): CheckoutState {
  const enabled = hostId !== null && projectId !== null;
  const query = useProjectSourceBranches(projectId ?? undefined, hostId, {
    enabled,
    query: "",
    selectedBranch: "",
  });
  const checkout = query.data?.checkout;

  return useMemo(
    () => ({
      isGit:
        query.data === undefined
          ? null
          : query.data.checkout.kind !== "unknown",
      unborn: checkout?.kind === "unborn",
      detached: checkout?.kind === "detached",
      dirty: query.data?.hasUncommittedChanges ?? false,
      currentBranch: checkout?.kind === "branch" ? checkout.branchName : null,
      operation: query.data?.operation ?? { kind: "none" },
    }),
    [checkout, query.data],
  );
}
