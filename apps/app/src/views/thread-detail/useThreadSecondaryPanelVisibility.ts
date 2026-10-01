import type {
  HostFileTabState,
  ThreadStorageFileTabState,
  WorkspaceFileTabState,
} from "@bb/client-core";
import type { FileOpenerOverride } from "@/lib/plugin-slot-resolvers";

export interface ThreadSecondaryPanelFileOpenOptions {
  viewer?: FileOpenerOverride;
}
export type ThreadSecondaryPanelWorkspaceFileOpenHandler = (
  file: WorkspaceFileTabState,
  options?: ThreadSecondaryPanelFileOpenOptions,
) => void;
export type ThreadSecondaryPanelStorageFileOpenHandler = (
  file: ThreadStorageFileTabState,
  options?: ThreadSecondaryPanelFileOpenOptions,
) => void;
export type ThreadSecondaryPanelHostFileOpenHandler = (
  file: HostFileTabState,
  options?: ThreadSecondaryPanelFileOpenOptions,
) => void;
