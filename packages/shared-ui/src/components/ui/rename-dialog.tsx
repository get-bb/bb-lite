import { useRef, useState, type ReactNode, type RefObject } from "react";
import { Dialog, DialogContent } from "./dialog.js";

export function useNameValidation({ emptyMessage }: { emptyMessage: string }) {
  const [validationMessage, setValidationMessage] = useState<string | null>(
    null,
  );
  return {
    validationMessage,
    validate: (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) setValidationMessage(emptyMessage);
      return trimmed || null;
    },
    clearMessage: () => setValidationMessage(null),
  };
}

export function RenameDialog({
  open,
  onOpenChange,
  shellClassName,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shellClassName?: string;
  children: (inputRef: RefObject<HTMLInputElement | null>) => ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const capturedOpenFocusRef = useRef(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={shellClassName}
        onOpenAutoFocus={(event) => {
          if (!capturedOpenFocusRef.current) {
            const activeElement = document.activeElement;
            returnFocusRef.current =
              activeElement instanceof HTMLElement &&
              activeElement !== document.body
                ? activeElement
                : null;
            capturedOpenFocusRef.current = true;
          }
          event.preventDefault();
          inputRef.current?.focus();
          inputRef.current?.select();
        }}
        onAfterCloseAutoFocus={() => {
          const returnFocus = returnFocusRef.current;
          returnFocusRef.current = null;
          capturedOpenFocusRef.current = false;
          if (
            returnFocus?.isConnected &&
            returnFocus.closest('[aria-hidden="true"], [inert]') === null
          ) {
            returnFocus.focus({ preventScroll: true });
          }
        }}
      >
        {children(inputRef)}
      </DialogContent>
    </Dialog>
  );
}
