import { useEffect, useRef } from "react";
import {
  resolveEnvironmentMergeBaseBranch,
  type Environment,
  type Thread,
  type WorkspaceStatus,
} from "@bb/domain";
import { appToast } from "@/components/ui/app-toast";
import {
  describeLifecycleError,
  parseLifecycleError,
} from "@/lib/lifecycle-errors";
import { showMutationErrorToast } from "@/lib/mutation-errors";
import type { useUpdateEnvironment } from "../../../hooks/mutations/environment-mutations";

interface UseEnvironmentMergeBaseParams {
  environment?: Environment;
  selectedMergeBaseBranch?: string;
  setSelectedMergeBaseBranch: (branch: string | undefined) => void;
  thread?: Thread;
  updateEnvironment: ReturnType<typeof useUpdateEnvironment>;
  workspaceStatus?: WorkspaceStatus;
}

export function useEnvironmentMergeBase({
  environment,
  selectedMergeBaseBranch,
  setSelectedMergeBaseBranch,
  thread,
  updateEnvironment,
  workspaceStatus,
}: UseEnvironmentMergeBaseParams) {
  const stateKeyRef = useRef<string | undefined>(undefined);
  const stateKey = environment?.id ?? thread?.id;
  const persistedBranch = environment?.mergeBaseBranch ?? undefined;
  const isUpdatePending =
    updateEnvironment.isPending &&
    updateEnvironment.variables?.id === environment?.id;

  useEffect(() => {
    if (
      stateKeyRef.current === stateKey &&
      (isUpdatePending || selectedMergeBaseBranch === persistedBranch)
    ) {
      return;
    }
    stateKeyRef.current = stateKey;
    setSelectedMergeBaseBranch(persistedBranch);
  }, [
    isUpdatePending,
    persistedBranch,
    selectedMergeBaseBranch,
    setSelectedMergeBaseBranch,
    stateKey,
  ]);

  const defaultBranch = workspaceStatus?.branch.defaultBranch;
  const effectiveMergeBaseBranch =
    selectedMergeBaseBranch ??
    environment?.mergeBaseBranch ??
    environment?.baseBranch ??
    workspaceStatus?.mergeBase?.mergeBaseBranch ??
    defaultBranch ??
    resolveEnvironmentMergeBaseBranch(environment);
  const showBranchComparisonUi = Boolean(
    effectiveMergeBaseBranch || defaultBranch,
  );
  const isOnDefaultBranch =
    workspaceStatus?.branch.currentBranch != null &&
    workspaceStatus.branch.currentBranch === defaultBranch;

  const handleMergeBaseBranchChange = (branch: string) => {
    if (!environment || !thread?.environmentId) return;
    const normalizedBranch = branch.trim();
    const implicitBranch =
      environment.baseBranch ?? defaultBranch ?? environment.defaultBranch;
    const nextPersistedBranch =
      normalizedBranch.length === 0 || normalizedBranch === implicitBranch
        ? null
        : normalizedBranch;
    setSelectedMergeBaseBranch(normalizedBranch);
    if (nextPersistedBranch === environment.mergeBaseBranch) return;
    updateEnvironment.mutate(
      { id: environment.id, mergeBaseBranch: nextPersistedBranch },
      {
        onError: (error) => {
          setSelectedMergeBaseBranch(environment.mergeBaseBranch ?? undefined);
          const lifecycleError = parseLifecycleError(error);
          if (
            lifecycleError?.code === "environment_not_ready" &&
            lifecycleError.details.environmentStatus === "provisioning"
          ) {
            return;
          }
          const description = describeLifecycleError({
            error,
            operation: "update_merge_base",
          });
          if (description) {
            appToast[description.severity === "error" ? "error" : "warning"](
              description.title,
              { description: description.body },
            );
            return;
          }
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to update merge base branch",
            lifecycleOperation: "update_merge_base",
          });
        },
      },
    );
  };

  return {
    effectiveMergeBaseBranch,
    handleMergeBaseBranchChange,
    showBranchComparisonUi,
    showMergeBase:
      showBranchComparisonUi &&
      Boolean(effectiveMergeBaseBranch) &&
      !isOnDefaultBranch,
  };
}
