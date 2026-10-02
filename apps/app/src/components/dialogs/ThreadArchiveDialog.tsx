import { useRef } from "react";
import type { Thread } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";

export interface ThreadArchiveDialogTarget {
  thread: Thread;
  childThreadCount: number;
}

export function ThreadArchiveDialog({
  target,
  pending,
  onOpenChange,
  onArchive,
}: {
  target: ThreadArchiveDialogTarget | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onArchive: (target: ThreadArchiveDialogTarget) => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const children = target?.childThreadCount ?? 0;
  const status = target?.thread.status;
  const active =
    status === "starting" || status === "active" || status === "stopping";
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current
            ?.querySelector<HTMLButtonElement>('button[type="submit"]')
            ?.focus();
        }}
      >
        {target ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!pending) onArchive(target);
            }}
          >
            <DialogHeader>
              <DialogTitle>Archive {children + 1} threads?</DialogTitle>
              <DialogDescription>
                {`${active ? "This will stop current work. " : ""}${children} child ${children === 1 ? "thread" : "threads"} will be archived with this thread. Archived threads stay available and can be unarchived.`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                Archive {children + 1} threads
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
