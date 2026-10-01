import type {
  HostFileTabState,
  ThreadStorageFileTabState,
  WorkspaceFileTabState,
} from "@bb/client-core";

export type ThreadSecondaryPanelWorkspaceFileOpenHandler = (
  file: WorkspaceFileTabState,
) => void;
export type ThreadSecondaryPanelStorageFileOpenHandler = (
  file: ThreadStorageFileTabState,
) => void;
export type ThreadSecondaryPanelHostFileOpenHandler = (
  file: HostFileTabState,
) => void;
