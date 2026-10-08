import {
  DetailCard,
  DetailRow,
  DetailRowIconLabel,
} from "@bb/app-kit/components/ui/detail-card";
import type { ThreadGitStatusDisplay } from "@bb/app-kit/components/workspace/workspace-status";
import { ChangedFilesDetailRow } from "@bb/app-kit/components/workspace/ChangedFilesDetailRow";
import type { WorkspaceChangedFilesSection } from "@bb/app-kit/components/workspace/workspace-change-summary";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";

export type ThreadGitActionDialogTarget = { kind: "commit" };

export function ThreadGitActionDialog({
  target,
  branchName,
  gitStatusDisplay,
  changedFilesSection,
  onOpenChange,
  onCommit,
}: {
  target: ThreadGitActionDialogTarget | null;
  branchName?: string;
  gitStatusDisplay?: ThreadGitStatusDisplay;
  changedFilesSection?: WorkspaceChangedFilesSection | null;
  onOpenChange: (open: boolean) => void;
  onCommit: () => Promise<void>;
}) {
  const changedFiles =
    changedFilesSection && changedFilesSection.files.length > 0
      ? changedFilesSection
      : null;
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[34rem] gap-0 overflow-hidden border-border bg-background p-0 shadow-sm">
        {target ? (
          <>
            <DialogHeader className="px-6 pt-5 pb-3">
              <DialogTitle>Commit changes</DialogTitle>
              <DialogDescription>
                Create a commit from the current workspace changes.
              </DialogDescription>
            </DialogHeader>
            <form
              className="space-y-4 px-6 pt-1 pb-5"
              onSubmit={(event) => {
                event.preventDefault();
                onOpenChange(false);
                void onCommit();
              }}
            >
              {branchName || gitStatusDisplay || changedFiles ? (
                <DetailCard>
                  {branchName ? (
                    <DetailRow
                      label={
                        <DetailRowIconLabel icon="GitBranch">
                          Branch
                        </DetailRowIconLabel>
                      }
                      valueClassName="min-w-0 truncate"
                    >
                      <span className="block truncate" title={branchName}>
                        {branchName}
                      </span>
                    </DetailRow>
                  ) : null}
                  {gitStatusDisplay ? (
                    <DetailRow
                      label={
                        <DetailRowIconLabel icon="FileDiff">
                          Git status
                        </DetailRowIconLabel>
                      }
                      valueClassName="min-w-0"
                    >
                      <div
                        className="flex min-w-0 items-baseline gap-2 whitespace-nowrap"
                        title={`${gitStatusDisplay.label} ${gitStatusDisplay.summary}`.trim()}
                      >
                        <span className="shrink-0 font-medium">
                          {gitStatusDisplay.label}
                        </span>
                        <span className="min-w-0 truncate text-muted-foreground">
                          {gitStatusDisplay.summary}
                        </span>
                      </div>
                    </DetailRow>
                  ) : null}
                  {changedFiles ? (
                    <ChangedFilesDetailRow
                      sections={[changedFiles]}
                      rowClassName="mt-3"
                      rowValueClassName="pt-0.5"
                      listClassName="max-h-40"
                    />
                  ) : null}
                </DetailCard>
              ) : null}
              <DialogFooter className="flex-row flex-wrap items-center justify-end gap-x-2 gap-y-1 sm:space-x-0">
                <Button type="submit" size="sm" className="shrink-0">
                  Commit changes
                </Button>
              </DialogFooter>
            </form>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
