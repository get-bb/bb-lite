import type { MarkdownPreviewLocalFileLink as ThreadTimelineLocalFileLink } from "@bb/app-kit/components/ui/markdown-local-file-link";
import type { FilePreviewLineRange } from "@bb/client-core";
import {
  isAbsoluteFilePathWithinRoot,
  normalizeAbsoluteFilePath,
} from "@bb/app-kit/lib/absolute-file-path";
import { isRoutePath } from "@bb/app-kit/lib/route-paths";

type ThreadLocalFileLinkResolution =
  | { kind: "app-route" }
  | { kind: "error"; description: string }
  | {
      kind: "open-workspace-path";
      request: {
        lineRange: FilePreviewLineRange | null;
        path: string;
        relativePath: string;
        workspaceRootPath: string;
      };
    }
  | {
      kind: "open-host-path";
      request: { lineRange: FilePreviewLineRange | null; path: string };
    };

export function resolveThreadLocalFileLink(args: {
  hostFileLinksAvailable: boolean;
  link: ThreadTimelineLocalFileLink;
  workspaceRootPath: string | null;
}): ThreadLocalFileLinkResolution {
  const { lineRange } = args.link;
  if (isRoutePath({ path: args.link.path })) return { kind: "app-route" };
  const path = normalizeAbsoluteFilePath({ path: args.link.path });
  if (path === null) {
    return {
      kind: "error",
      description: "Thread file links must use absolute file paths.",
    };
  }
  const root =
    args.workspaceRootPath === null
      ? null
      : normalizeAbsoluteFilePath({ path: args.workspaceRootPath });
  if (
    root !== null &&
    path !== root &&
    isAbsoluteFilePathWithinRoot({ candidatePath: path, rootPath: root })
  ) {
    const relativePath = path.slice(root === "/" ? 1 : root.length + 1);
    return {
      kind: "open-workspace-path",
      request: { lineRange, path, relativePath, workspaceRootPath: root },
    };
  }
  if (!args.hostFileLinksAvailable) {
    return {
      kind: "error",
      description:
        "Thread file links are only available when the thread has an environment.",
    };
  }
  return { kind: "open-host-path", request: { lineRange, path } };
}
