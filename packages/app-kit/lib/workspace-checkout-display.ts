import type { GitCheckoutRef } from "@bb/domain";

export interface WorkspaceCheckoutDisplay {
  copyErrorMessage: string | null;
  copyLabel: string | null;
  copySuccessMessage: string | null;
  copyValue: string | null;
  label: string;
  rowLabel: "Branch" | "Checkout";
  title: string;
}

const NOT_COPYABLE = {
  copyErrorMessage: null,
  copyLabel: null,
  copySuccessMessage: null,
  copyValue: null,
  rowLabel: "Checkout",
} as const;

function copyable(name: "branch name" | "commit SHA", copyValue: string) {
  return {
    copyErrorMessage: `Failed to copy ${name}`,
    copyLabel: `Copy ${name}`,
    copySuccessMessage: `${name[0]?.toUpperCase()}${name.slice(1)} copied`,
    copyValue,
  };
}

export function formatWorkspaceCheckoutDisplay({
  checkout,
}: {
  checkout: GitCheckoutRef;
}): WorkspaceCheckoutDisplay {
  switch (checkout.kind) {
    case "branch":
      return {
        ...copyable("branch name", checkout.branchName),
        label: checkout.branchName,
        rowLabel: "Branch",
        title: `Copy branch name: ${checkout.branchName}`,
      };
    case "detached":
      return checkout.headSha === null
        ? { ...NOT_COPYABLE, label: "detached HEAD", title: "Detached HEAD" }
        : {
            ...copyable("commit SHA", checkout.headSha),
            label: `detached ${checkout.headSha.slice(0, 7)}`,
            rowLabel: "Checkout",
            title: `Detached HEAD: ${checkout.headSha}`,
          };
    case "unborn":
      return checkout.branchName === null
        ? { ...NOT_COPYABLE, label: "empty repo", title: "Empty repository" }
        : {
            ...NOT_COPYABLE,
            label: `${checkout.branchName} (empty)`,
            title: `Empty branch: ${checkout.branchName}`,
          };
    case "unknown":
      return {
        ...NOT_COPYABLE,
        label: "unknown checkout",
        title: `Unknown checkout: ${checkout.reason}`,
      };
  }
}
