import type { ReactNode } from "react";
import { Button } from "./button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog.js";

export function ConfirmDeleteDialogContent({
  title,
  description,
  confirmLabel,
  pending,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        {onCancel ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </Button>
        ) : null}
        <Button
          type="button"
          variant="destructive"
          disabled={pending}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </>
  );
}

export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal>
      <DialogContent>{open ? children : null}</DialogContent>
    </Dialog>
  );
}
