import {
  useCallback,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Dialog, DialogContent } from "./dialog.js";

interface UseNameValidationArgs {
  emptyMessage: string;
}

interface UseNameValidationResult {
  validationMessage: string | null;
  validate: (value: string) => string | null;
  clearMessage: () => void;
}

export function useNameValidation({
  emptyMessage,
}: UseNameValidationArgs): UseNameValidationResult {
  const [validationMessage, setValidationMessage] = useState<string | null>(
    null,
  );

  const validate = useCallback(
    (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) {
        setValidationMessage(emptyMessage);
        return null;
      }
      return trimmed;
    },
    [emptyMessage],
  );

  const clearMessage = useCallback(() => setValidationMessage(null), []);

  return { validationMessage, validate, clearMessage };
}

interface RenameDialogAutoFocus {
  inputRef: RefObject<HTMLInputElement | null>;
  handleOpenAutoFocus: (event: Event) => void;
}

export function useRenameDialogAutoFocus(): RenameDialogAutoFocus {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const handleOpenAutoFocus = useCallback((event: Event) => {
    event.preventDefault();

    const input = inputRef.current;
    if (input) {
      input.focus();
      input.select();
    }
  }, []);
  return { inputRef, handleOpenAutoFocus };
}

interface RenameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shellClassName?: string;
  children: (inputRef: RefObject<HTMLInputElement | null>) => ReactNode;
}

export function RenameDialog({
  open,
  onOpenChange,
  shellClassName,
  children,
}: RenameDialogProps) {
  const { inputRef, handleOpenAutoFocus: focusInputOnOpen } =
    useRenameDialogAutoFocus();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const capturedOpenFocusRef = useRef(false);
  const handleOpenAutoFocus = useCallback(
    (event: Event) => {
      if (!capturedOpenFocusRef.current) {
        const activeElement = document.activeElement;
        returnFocusRef.current =
          activeElement instanceof HTMLElement &&
          activeElement !== document.body
            ? activeElement
            : null;
        capturedOpenFocusRef.current = true;
      }
      focusInputOnOpen(event);
    },
    [focusInputOnOpen],
  );
  const handleAfterCloseAutoFocus = useCallback(() => {
    const returnFocus = returnFocusRef.current;
    returnFocusRef.current = null;
    capturedOpenFocusRef.current = false;
    if (
      returnFocus?.isConnected &&
      returnFocus.closest('[aria-hidden="true"], [inert]') === null
    ) {
      returnFocus.focus({ preventScroll: true });
    }
  }, []);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={shellClassName}
        onOpenAutoFocus={handleOpenAutoFocus}
        onAfterCloseAutoFocus={handleAfterCloseAutoFocus}
      >
        {children(inputRef)}
      </DialogContent>
    </Dialog>
  );
}
