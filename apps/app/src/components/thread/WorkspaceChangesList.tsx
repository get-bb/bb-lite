import type { WorkspaceStatus } from "@bb/domain";
import { DiffStatsTally } from "@/components/ui/diff-stats-tally.js";
import { EmptyState } from "@bb/shared-ui/empty-state";
import { FilePathLink } from "@/components/ui/file-path-link.js";
import { TruncatedList } from "@/components/ui/truncated-list.js";
import { cn } from "@bb/shared-ui/lib/utils";
import { formatWorkspaceFileStatus } from "@/components/workspace/workspace-change-summary";

type ChangedFile = WorkspaceStatus["workingTree"]["files"][number];

const ROW_CLASS =
  "grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-x-3";
const MAX_ROWS = 200;

const fileKey = (file: ChangedFile) => `${file.status}:${file.path}`;

export function WorkspaceChangesList({
  files,
  className = "max-h-32",
  onFileClick,
  limit,
}: {
  files: readonly ChangedFile[];
  className?: string;
  onFileClick?: (file: ChangedFile) => void;
  limit?: number;
}) {
  if (!files || files.length === 0) {
    return <EmptyState message="No changed files detected." />;
  }
  const renderItem = (file: ChangedFile) => {
    const content = (
      <>
        <span className="text-xs leading-5 text-muted-foreground opacity-70">
          {formatWorkspaceFileStatus(file.status)}
        </span>
        <FilePathLink
          path={file.path}
          className={cn(
            "opacity-70",
            onFileClick ? "group-hover:underline" : undefined,
          )}
        />
        {file.insertions !== null && file.deletions !== null ? (
          <DiffStatsTally
            insertions={file.insertions}
            deletions={file.deletions}
            hideZero
            className="text-xs leading-5"
          />
        ) : null}
      </>
    );
    return onFileClick ? (
      <button
        type="button"
        className={cn(
          ROW_CLASS,
          "group w-full rounded px-1 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        aria-label={`Open ${file.path}`}
        onClick={() => onFileClick(file)}
      >
        {content}
      </button>
    ) : (
      <div className={ROW_CLASS}>{content}</div>
    );
  };
  if (limit !== undefined) {
    return (
      <TruncatedList
        items={files}
        getKey={fileKey}
        limit={limit}
        renderItem={renderItem}
      />
    );
  }
  const hiddenFileCount = Math.max(0, files.length - MAX_ROWS);
  return (
    <ul className={cn("space-y-1 overflow-auto", className)}>
      {files.slice(0, MAX_ROWS).map((file) => (
        <li key={fileKey(file)}>{renderItem(file)}</li>
      ))}
      {hiddenFileCount > 0 ? (
        <li className="px-1 text-xs leading-5 text-muted-foreground">
          {`${hiddenFileCount.toLocaleString()} more ${hiddenFileCount === 1 ? "file" : "files"} not shown`}
        </li>
      ) : null}
    </ul>
  );
}
