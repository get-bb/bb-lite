import { sidePanel } from "@bb/plugin/app";
import { SlotMount, useSlotEntries } from "@bb/app-kit/plugins/slots";
import type { UseQueryResult } from "@tanstack/react-query";
import type { MarkdownLinkRouting } from "@bb/app-kit/components/ui/markdown-link-routing";
import {
  useEnvironment,
  useEnvironmentFilePreview,
} from "@bb/app-kit/hooks/queries/environment-queries";
import { useThreadHostFilePreview } from "@bb/app-kit/hooks/queries/thread-queries";
import {
  buildEnvironmentFileContentUrl,
  buildThreadHostFileContentUrl,
} from "@bb/app-kit/lib/file-content-urls";
import type {
  EnvironmentFilePreviewSource,
  FilePreview as FilePreviewData,
  FilePreviewLineRange,
  WorkspaceFilePreviewStatusLabel,
} from "@bb/client-core";
import { buildMarkdownFileImageRouting } from "@bb/app-kit/components/ui/markdown-file-image-routing";
import { getAbsoluteDirname } from "@bb/app-kit/lib/absolute-file-path";
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
  const viewers = useSlotEntries(sidePanel.fileViewer);
  const extension = activePath.split(".").at(-1)?.toLowerCase() ?? "";
  const viewer = viewers
    .filter(({ item }) => item.extensions.includes(extension))
    .at(-1);
  const { data } = query;
  if (viewer !== undefined && data?.path === activePath) {
    const View = viewer.item.view;
    return (
      <SlotMount
        pluginId={viewer.plugin}
        slot={sidePanel.fileViewer.name}
        id={viewer.item.id}
      >
        <View
          path={activePath}
          name={data.name ?? activePath}
          url={data.url ?? null}
          mimeType={data.mimeType ?? null}
          content={data.kind === "text" ? data.content : null}
          refresh={() => void query.refetch()}
        />
      </SlotMount>
    );
  }
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
