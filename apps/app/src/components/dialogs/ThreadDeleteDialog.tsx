import type { Thread } from "@bb/domain";
import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "@bb/shared-ui/confirm-delete-dialog";

export interface ThreadDeleteDialogTarget {
  thread: Thread;
  childThreadCount?: number;
}

export function ThreadDeleteDialog({
  target,
  pending,
  onOpenChange,
  onDelete,
}: {
  target: ThreadDeleteDialogTarget | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (target: ThreadDeleteDialogTarget) => void;
}) {
  return (
    <ConfirmDeleteDialog open={target !== null} onOpenChange={onOpenChange}>
      {target ? (
        <ConfirmDeleteDialogContent
          title="Delete thread?"
          description={`${target.childThreadCount ? "Child threads will be deleted. " : ""}This action cannot be undone.`}
          confirmLabel="Delete thread"
          pending={pending}
          onConfirm={() => onDelete(target)}
          onCancel={() => onOpenChange(false)}
        />
      ) : null}
    </ConfirmDeleteDialog>
  );
}
