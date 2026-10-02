import type { WorkspaceFileStatus } from "@bb/domain";
import type { WorkspaceChangedFilesSection } from "@/components/workspace/workspace-change-summary";
import type {
  EnvironmentFilePreviewSource,
  WorkspaceFilePreviewStatusLabel,
} from "@bb/client-core";
import { buildAbsoluteFilePath } from "@/lib/absolute-file-path";

interface BuildOpenInEditorHandlerArgs {
  rootPath: string | null;
  openInPreferredTarget:
    | ((request: { lineNumber: number | null; path: string }) => void)
    | undefined;
}

export function buildOpenInEditorHandler(
  args: BuildOpenInEditorHandlerArgs,
): ((relativePath: string) => void) | undefined {
  const { rootPath, openInPreferredTarget } = args;
  if (!rootPath || !openInPreferredTarget) {
    return undefined;
  }
  return (relativePath) => {
    openInPreferredTarget({
      lineNumber: null,
      path: buildAbsoluteFilePath({ path: relativePath, rootPath }),
    });
  };
}

type WorkspaceChangedFileOpenTarget =
  | { kind: "diff" }
  | {
      kind: "preview";
      source: EnvironmentFilePreviewSource;
      statusLabel: WorkspaceFilePreviewStatusLabel | null;
    };

interface ResolveWorkspaceChangedFileOpenTargetArgs {
  file: WorkspaceFileStatus;
  section: WorkspaceChangedFilesSection;
}

export function resolveWorkspaceChangedFileOpenTarget(
  args: ResolveWorkspaceChangedFileOpenTargetArgs,
): WorkspaceChangedFileOpenTarget {
  if (args.file.status === "A" || args.file.status === "??") {
    return {
      kind: "preview",
      source: { kind: "working-tree" },
      statusLabel: null,
    };
  }

  if (args.file.status === "D") {
    if (args.section.kind === "committed") {
      return args.section.mergeBaseRef
        ? {
            kind: "preview",
            source: { kind: "merge-base", ref: args.section.mergeBaseRef },
            statusLabel: "deleted",
          }
        : { kind: "diff" };
    }
    return {
      kind: "preview",
      source: { kind: "head" },
      statusLabel: "deleted",
    };
  }

  return { kind: "diff" };
}
