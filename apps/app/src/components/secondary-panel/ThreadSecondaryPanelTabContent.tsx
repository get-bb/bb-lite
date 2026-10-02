import type { UseQueryResult } from "@tanstack/react-query";
import type { MarkdownLinkRouting } from "@/components/ui/markdown-link-routing.js";
import {
  useEnvironment,
  useEnvironmentFilePreview,
} from "@/hooks/queries/environment-queries";
import { useProjectFilePreview } from "@/hooks/queries/project-queries";
import { useThreadHostFilePreview } from "@/hooks/queries/thread-queries";
import {
  buildEnvironmentFileContentUrl,
  buildProjectFileContentUrl,
  buildThreadHostFileContentUrl,
} from "@/lib/file-content-urls";
import type {
  EnvironmentFilePreviewSource,
  FilePreview as FilePreviewData,
  FilePreviewLineRange,
  WorkspaceFilePreviewStatusLabel,
} from "@bb/client-core";
import { buildMarkdownFileImageRouting } from "@/components/ui/markdown-file-image-routing";
import { getAbsoluteDirname } from "@/lib/absolute-file-path";
import { FilePreview, resolveFilePreviewState } from "./FilePreview";

interface FilePreviewTabProps {
  activePath: string;
  isPanelOpen: boolean;
  copyPath?: string | null;
  lineRange: FilePreviewLineRange | null;
  markdownLinkRouting?: MarkdownLinkRouting;
  onOpenInEditor?: (path: string) => void;
}

interface QueryFilePreviewProps extends Omit<
  FilePreviewTabProps,
  "isPanelOpen"
> {
  query: UseQueryResult<FilePreviewData>;
  statusLabel?: WorkspaceFilePreviewStatusLabel | null;
}

function QueryFilePreview({
  activePath,
  copyPath,
  lineRange,
  markdownLinkRouting,
  onOpenInEditor,
  query,
  statusLabel,
}: QueryFilePreviewProps) {
  return (
    <FilePreview
      path={activePath}
      copyPath={copyPath}
      lineRange={lineRange}
      onOpenInEditor={onOpenInEditor}
      onRefresh={() => void query.refetch()}
      isRefreshing={query.isFetching}
      markdownLinkRouting={markdownLinkRouting}
      statusLabel={statusLabel}
      state={resolveFilePreviewState(query, activePath)}
    />
  );
}

interface WorkspaceFilePreviewTabContentProps extends FilePreviewTabProps {
  environmentId: string;
  source: EnvironmentFilePreviewSource;
  statusLabel: WorkspaceFilePreviewStatusLabel | null;
  threadId?: string | null;
}

export function WorkspaceFilePreviewTabContent({
  environmentId,
  isPanelOpen,
  source,
  threadId = null,
  ...props
}: WorkspaceFilePreviewTabContentProps) {
  const { activePath, markdownLinkRouting } = props;
  const environmentQuery = useEnvironment(environmentId, {
    enabled: markdownLinkRouting?.localImage === undefined,
    staleTime: 5_000,
  });
  const query = useEnvironmentFilePreview(environmentId, activePath, source, {
    enabled: isPanelOpen,
  });
  return (
    <QueryFilePreview
      {...props}
      query={query}
      markdownLinkRouting={buildMarkdownFileImageRouting({
        path: activePath,
        rootPath: environmentQuery.data?.path ?? null,
        threadId,
        linkRouting: markdownLinkRouting,
        resolveRelativeSrc: (path) =>
          buildEnvironmentFileContentUrl(environmentId, source, path),
      })}
    />
  );
}

interface ProjectFilePreviewTabContentProps extends FilePreviewTabProps {
  environmentId: string | null;
  hostId: string | null;
  projectId: string;
  rootPath?: string | null;
  threadId?: string | null;
}

export function ProjectFilePreviewTabContent({
  environmentId,
  hostId,
  isPanelOpen,
  projectId,
  rootPath = null,
  threadId = null,
  ...props
}: ProjectFilePreviewTabContentProps) {
  const { activePath, markdownLinkRouting } = props;
  const query = useProjectFilePreview(
    projectId,
    activePath,
    { environmentId, hostId },
    { enabled: isPanelOpen },
  );
  return (
    <QueryFilePreview
      {...props}
      query={query}
      markdownLinkRouting={buildMarkdownFileImageRouting({
        path: activePath,
        rootPath,
        threadId,
        linkRouting: markdownLinkRouting,
        resolveRelativeSrc: (path) =>
          buildProjectFileContentUrl(projectId, path, {
            environmentId,
            hostId,
          }),
      })}
    />
  );
}

interface HostFilePreviewTabContentProps extends FilePreviewTabProps {
  environmentId?: string | null;
  threadId: string;
}

export function HostFilePreviewTabContent({
  environmentId,
  isPanelOpen,
  threadId,
  ...props
}: HostFilePreviewTabContentProps) {
  const { activePath, markdownLinkRouting } = props;
  const query = useThreadHostFilePreview(threadId, environmentId, activePath, {
    enabled: isPanelOpen,
  });
  return (
    <QueryFilePreview
      {...props}
      query={query}
      markdownLinkRouting={buildMarkdownFileImageRouting({
        path: activePath,
        rootPath:
          markdownLinkRouting?.localFile?.relativeLinks?.rootPath ??
          getAbsoluteDirname({ path: activePath }),
        threadId,
        linkRouting: markdownLinkRouting,
        resolveRelativeSrc: (_relativePath, path) =>
          buildThreadHostFileContentUrl(threadId, path),
      })}
    />
  );
}
