import { useCallback, useRef } from "react";

interface RenameDialogAutoFocus {
  inputRef: React.RefObject<HTMLInputElement | null>;
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
