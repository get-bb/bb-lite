import type { GitDiffFileChangeKind } from "@bb/server-contract";
import { CopyButton } from "@/components/ui/copy-button.js";
import { DiffStatsTally } from "@/components/ui/diff-stats-tally.js";
import { FilePathLink } from "@/components/ui/file-path-link.js";
import { Icon } from "@bb/shared-ui/icon";
import { OpenInEditorButton } from "@/components/ui/open-in-editor-button.js";
import { TruncateStart } from "@/components/ui/truncate-start.js";
import { resolveAbsoluteFilePath } from "@/lib/absolute-file-path";
import { cn } from "@bb/shared-ui/lib/utils";

export interface GitDiffCardHeaderModel {
  label: string;
  path: string;
  openablePath: string | null;
  changeKind: GitDiffFileChangeKind;
  insertions: number;
  deletions: number;
}

interface GitDiffCardHeaderProps {
  model: GitDiffCardHeaderModel;
  previousPath: string | null;
  filePathRoot?: string | null;
  onOpenFileInEditor?: (path: string) => void;
  onOpenFilePreview?: (path: string) => void;
  isCollapsed?: boolean;
  onToggleCollapsed?: () => void;
  hasChanges: boolean;
}

export function GitDiffCardHeader({
  model,
  previousPath,
  filePathRoot,
  onOpenFileInEditor,
  onOpenFilePreview,
  isCollapsed,
  onToggleCollapsed,
  hasChanges,
}: GitDiffCardHeaderProps) {
  const isAddedFile = model.changeKind === "added";
  const isDeletedFile = model.changeKind === "deleted";
  const renamedFrom =
    (model.changeKind === "renamed" || model.changeKind === "copied") &&
    previousPath &&
    previousPath !== model.path
      ? previousPath
      : null;
  const openablePath = model.openablePath;
  const copyablePath = openablePath
    ? resolveAbsoluteFilePath({ path: openablePath, rootPath: filePathRoot })
    : null;

  return (
    <div className="flex w-full min-w-0 items-center justify-between gap-2">
      <span className="flex min-w-0 items-center">
        {onToggleCollapsed !== undefined ? (
          <button
            type="button"
            className={cn(
              "inline-flex w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors",
              hasChanges
                ? "hover:text-foreground"
                : "cursor-not-allowed opacity-40",
            )}
            onClick={hasChanges ? onToggleCollapsed : undefined}
            disabled={!hasChanges}
            aria-label={
              hasChanges
                ? `${isCollapsed ? "Expand" : "Collapse"} ${model.label}`
                : `${model.label} has no changes to expand`
            }
            aria-expanded={hasChanges ? !isCollapsed : undefined}
          >
            <Icon
              name="ChevronRight"
              className={cn(
                "size-3.5 shrink-0 transition-transform duration-150",
                hasChanges && !isCollapsed && "rotate-90",
              )}
            />
          </button>
        ) : null}
        <span className={cn("flex min-w-0 items-center gap-1.5", "pl-[1ch]")}>
          {renamedFrom ? (
            <>
              <TruncateStart
                className="min-w-0 font-mono text-xs leading-5 text-muted-foreground"
                title={renamedFrom}
              >
                {renamedFrom}
              </TruncateStart>
              <Icon
                name="ArrowRight"
                aria-hidden="true"
                className="size-3 shrink-0 text-subtle-foreground"
              />
            </>
          ) : null}
          <FilePathLink
            path={openablePath ?? model.path}
            displayName={renamedFrom ? model.path : model.label}
            onClick={
              openablePath && onOpenFilePreview
                ? () => onOpenFilePreview(openablePath)
                : undefined
            }
            className="font-mono font-medium text-foreground"
          />
          {copyablePath ? (
            <CopyButton
              text={copyablePath}
              label={`Copy path for ${model.label}`}
              className="rounded-md hover:bg-state-hover"
            />
          ) : null}
          {openablePath && onOpenFileInEditor ? (
            <OpenInEditorButton
              onClick={() => onOpenFileInEditor(openablePath)}
              label={`Open ${model.label} in editor`}
            />
          ) : null}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <DiffStatsTally
          insertions={isDeletedFile ? 0 : model.insertions}
          deletions={isAddedFile ? 0 : model.deletions}
          hideZero={isAddedFile || isDeletedFile}
          className="text-xs"
        />
      </span>
    </div>
  );
}

interface GitDiffCardHeaderWrapperClassArgs {
  stickyHeader: boolean;
  isBodyHidden: boolean;
  isStuck: boolean;
  showStuckHeaderEdge?: boolean;
}

export function gitDiffCardHeaderWrapperClass({
  stickyHeader,
  isBodyHidden,
  isStuck,
  showStuckHeaderEdge = true,
}: GitDiffCardHeaderWrapperClassArgs): string {
  return cn(
    "rounded-lg bg-background py-1.5 pl-2 pr-3 text-xs font-medium text-foreground",
    stickyHeader && "sticky z-30",
    stickyHeader && "top-0",
    !isBodyHidden && "rounded-b-none",
    isStuck && "rounded-t-none",
    isStuck && showStuckHeaderEdge && "shadow-[inset_0_1px_0_var(--border)]",
  );
}
