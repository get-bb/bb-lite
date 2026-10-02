import { RenameDialog } from "./RenameDialog";

export interface ThreadRenameDialogTarget {
  id: string;
  currentTitle: string;
}

export interface ThreadRenameDialogPayload {
  title: string;
}

export function ThreadRenameDialog({
  target,
  pending = false,
  onOpenChange,
  onRename,
}: {
  target: ThreadRenameDialogTarget | null;
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: (threadId: string, payload: ThreadRenameDialogPayload) => void;
}) {
  return (
    <RenameDialog
      target={target && { key: target.id, name: target.currentTitle }}
      entityLabel="thread"
      autoCapitalize="sentences"
      compact
      shellClassName="max-w-[24rem] sm:gap-3 sm:p-5"
      pending={pending}
      onOpenChange={onOpenChange}
      onRename={(title) => target && onRename(target.id, { title })}
    />
  );
}
