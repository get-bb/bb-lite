import { useEffect, useId, useRef, useState } from "react";
import { BbHttpError } from "@bb/sdk/browser";
import { cn } from "@bb/shared-ui/lib/utils";

interface RenameSession {
  id: string;
  draft: string;
  pending: boolean;
  error: string | null;
  cannotRetry: boolean;
}

function renameError(error: unknown) {
  const status = error instanceof BbHttpError ? error.status : null;
  if (status === 404 || status === 410) {
    return { error: "This item no longer exists.", cannotRetry: true };
  }
  if (status === 401 || status === 403) {
    return {
      error: "You do not have permission to rename this item.",
      cannotRetry: true,
    };
  }
  return { error: "Could not save the name. Try again.", cannotRetry: false };
}

export function useInlineRename({
  id,
  name,
  label,
  onSave,
}: {
  id: string;
  name: string;
  label: string;
  onSave: (name: string) => Promise<unknown>;
}) {
  const [stored, setStored] = useState<RenameSession | null>(null);
  const sessionRef = useRef<RenameSession | null>(null);
  const session = stored?.id === id ? stored : null;
  const isEditing = session !== null;
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const openingRef = useRef(false);
  const errorId = useId();

  useEffect(() => {
    if (!isEditing) return;
    openingRef.current = true;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
      openingRef.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [isEditing]);

  const update = (next: RenameSession | null) => {
    sessionRef.current = next;
    setStored(next);
  };
  const submit = () => {
    const current = sessionRef.current;
    if (current?.id !== id || current.pending || current.cannotRetry) return;
    const input = inputRef.current;
    input?.setSelectionRange(input.value.length, input.value.length);
    const value = current.draft.trim();
    if (!value) {
      update({ ...current, error: "Name cannot be empty." });
    } else if (value === name.trim()) {
      update(null);
    } else {
      update({ ...current, pending: true, error: null });
      void Promise.resolve()
        .then(() => onSave(value))
        .then(
          () => update(null),
          (error: unknown) =>
            update({ ...current, pending: false, ...renameError(error) }),
        );
    }
  };

  const editor = session ? (
    <span
      data-sidebar-rename-editor=""
      className="relative z-50 flex min-w-0 flex-1 items-center gap-1"
      aria-busy={session.pending}
      onBlur={() => {
        if (!openingRef.current) submit();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onDragStart={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyUp={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || composingRef.current) return;
        if (event.key === "Escape") {
          event.preventDefault();
          if (!session.pending) update(null);
        } else if (event.key === "Enter" && event.target === inputRef.current) {
          event.preventDefault();
          submit();
        }
      }}
    >
      <input
        ref={inputRef}
        aria-label={label}
        aria-invalid={Boolean(session.error)}
        aria-describedby={session.error ? errorId : undefined}
        autoCapitalize="sentences"
        autoCorrect="off"
        className={cn(
          "min-w-0 flex-1 appearance-none border-0 bg-transparent px-0 py-0 [font:inherit] outline-none field-sizing-content",
          session.pending && "animate-shine motion-reduce:opacity-60",
        )}
        spellCheck={false}
        value={session.draft}
        readOnly={session.pending || session.cannotRetry}
        onChange={(event) => {
          if (session.pending) return;
          update({
            ...session,
            draft: event.target.value,
            error: null,
            cannotRetry: false,
          });
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
      />
      {session.pending && (
        <span role="status" aria-label="Saving name" className="sr-only">
          Saving name
        </span>
      )}
      {session.error && (
        <span
          id={errorId}
          role="alert"
          className="absolute left-0 top-full z-50 mt-1 w-full min-w-40 rounded-md border border-border bg-popover px-2 py-1 text-xs text-destructive shadow-md whitespace-normal"
        >
          {session.error}
        </span>
      )}
    </span>
  ) : null;

  return {
    editor,
    isEditing,
    startEditing: () =>
      update({
        id,
        draft: name,
        pending: false,
        error: null,
        cannotRetry: false,
      }),
  };
}
