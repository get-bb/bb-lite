import { createElement } from "react";
import { appToast } from "@/components/ui/app-toast";
import { AppToastCommitDescription } from "@/components/ui/app-toast-descriptions";
import type { Environment, Thread, WorkspaceStatus } from "@bb/domain";
import { useDialogState } from "@/hooks/useDialogState";
import type { ThreadGitActionDialogTarget } from "@/components/dialogs/ThreadGitActionDialog";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import type { RequestEnvironmentActionMutationLike } from "./threadDetailMutationTypes";

interface UseThreadGitActionsParams {
  environment?: Environment;
  requestEnvironmentAction: RequestEnvironmentActionMutationLike;
  thread?: Thread;
  workspaceStatus?: WorkspaceStatus;
}

export interface ThreadHeaderGitAction {
  label: string;
  target: ThreadGitActionDialogTarget;
}

const NO_GIT_ACTIONS: ThreadHeaderGitAction[] = [];
const COMMIT_GIT_ACTIONS: ThreadHeaderGitAction[] = [
  { target: { kind: "commit" }, label: "Commit" },
];

export function useThreadGitActions({
  environment,
  requestEnvironmentAction,
  thread,
  workspaceStatus,
}: UseThreadGitActionsParams) {
  const threadGitActionDialog = useDialogState<ThreadGitActionDialogTarget>();
  const canCommit =
    thread !== undefined &&
    environment !== undefined &&
    thread.archivedAt == null &&
    workspaceStatus?.workingTree.hasUncommittedChanges === true;

  const handleCommitThread = async () => {
    const environmentId = thread?.environmentId;
    if (!environmentId) return;
    const toastId = appToast.loading("Creating commit");
    try {
      const response = await requestEnvironmentAction.mutateAsync({
        id: environmentId,
        action: "commit",
      });
      if (response.action !== "commit") {
        throw new Error("Expected commit action response.");
      }
      appToast.success("Commit created", {
        id: toastId,
        description: createElement(AppToastCommitDescription, {
          commitSha: response.commitSha,
          commitSubject: response.commitSubject,
        }),
      });
    } catch (error) {
      const message = getMutationErrorMessage({
        error,
        fallbackMessage: "Failed to start git action",
        lifecycleOperation: "commit",
      });
      appToast.error("Commit failed", {
        id: toastId,
        ...(message === "Commit failed" ? {} : { description: message }),
      });
    }
  };

  return {
    handleCommitThread,
    threadGitActionDialog,
    threadHeaderGitActions: canCommit ? COMMIT_GIT_ACTIONS : NO_GIT_ACTIONS,
  };
}
