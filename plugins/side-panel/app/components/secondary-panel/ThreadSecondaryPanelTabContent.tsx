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
import { buildMarkdownFileImageRouting } from "../ui/markdown-file-image-routing";
import { matchesFileViewer } from "../../lib/file-viewer-match";
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
  threadId: string | null;
  source: "workspace" | "host";
  projectId: string | null;
  hostId: string | null;
}

function QueryFilePreview({
  activePath,
  copyPath,
  lineRange,
  markdownLinkRouting,
  onOpenInEditor,
  query,
  statusLabel,
  threadId,
  source,
  projectId,
  hostId,
}: QueryFilePreviewProps) {
  const viewers = useSlotEntries(sidePanel.fileViewer);
  const viewer = viewers
    .filter(({ item }) => matchesFileViewer(item, activePath))
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
          threadId={threadId}
          source={source}
          projectId={projectId}
          hostId={hostId}
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
  const environmentQuery = useEnvironment(environmentId, { staleTime: 5_000 });
  const query = useEnvironmentFilePreview(environmentId, activePath, source, {
    enabled: isPanelOpen,
  });
  return (
    <QueryFilePreview
      {...props}
      query={query}
      threadId={threadId}
      source="workspace"
      projectId={environmentQuery.data?.projectId ?? null}
      hostId={environmentQuery.data?.hostId ?? null}
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
  const environment = useEnvironment(environmentId ?? "", {
    staleTime: 5_000,
  }).data;
  const query = useThreadHostFilePreview(threadId, environmentId, activePath, {
    enabled: isPanelOpen,
  });
  return (
    <QueryFilePreview
      {...props}
      query={query}
      threadId={threadId}
      source="host"
      projectId={environment?.projectId ?? null}
      hostId={environment?.hostId ?? null}
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
