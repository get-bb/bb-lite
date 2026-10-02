import type { PermissionMode } from "@bb/domain";
import type { IconName } from "@bb/shared-ui/icon";

export interface PermissionModeOption {
  value: PermissionMode;
  label: string;
  description: string;
  tone?: "warning";
  iconName: IconName;
}

export const PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  {
    value: "accept-edits",
    label: "Accept Edits",
    description:
      "Applies edits inside the workspace automatically. Anything beyond the workspace asks you first.",
    iconName: "FolderEdit",
  },
  {
    value: "auto",
    label: "Approve for me",
    description:
      "Same workspace sandbox, with requests reviewed automatically. High-risk actions can still come back to you.",
    iconName: "SecurityCheck",
  },
  {
    value: "full",
    label: "Full Access",
    tone: "warning",
    description:
      "No sandbox and no approvals — the agent can run anything on your machine.",
    iconName: "SquareUnlock02",
  },
];
