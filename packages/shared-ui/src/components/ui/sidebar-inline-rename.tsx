import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "./icon.js";
import { cn } from "../../lib/utils";
import { SIDEBAR_CONTROL_BUTTON_CLASS } from "./sidebar-row-classes.js";

interface SidebarRenameArgs {
  kind: "thread" | "section" | "environment";
  id: string;
  name: string;
  label: string;
  onSave: (name: string) => Promise<unknown>;
  maxLength?: number;
  placeholder?: string;
  inputClassName?: string;
  onClear?: () => Promise<unknown>;
  ownerKey?: string;
}

interface RenameSession extends SidebarRenameArgs {
  ownerKey: string;
  draft: string;
  pending: Promise<boolean> | null;
  error: string | null;
  cannotRetry: boolean;
}

function useRenameController() {
  const [session, setSession] = useState<RenameSession | null>(null);
  const sessionRef = useRef<RenameSession | null>(null);
  const startRequestRef = useRef(0);
  const update = useCallback((next: RenameSession | null) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const save = useCallback(
    (clear = false): Promise<boolean> => {
      const current = sessionRef.current;
      if (!current) return Promise.resolve(false);
      if (current.pending) return current.pending;
      if (current.cannotRetry) return Promise.resolve(false);
      const value = current.draft.trim();
      const shouldClear = clear || (!value && Boolean(current.onClear));
      const error = shouldClear
        ? null
        : !value
          ? "Name cannot be empty."
          : current.maxLength && value.length > current.maxLength
            ? `Name must be ${current.maxLength} characters or fewer.`
            : null;
      if (error) {
        update({ ...current, error });
        return Promise.resolve(false);
      }
      if (
        (!shouldClear && value === current.name.trim()) ||
        (shouldClear && !current.name)
      ) {
        update(null);
        return Promise.resolve(true);
      }
      if (shouldClear && !current.onClear) return Promise.resolve(false);
      const pending = Promise.resolve()
        .then(() => (shouldClear ? current.onClear?.() : current.onSave(value)))
        .then(
          () => {
            update(null);
            return true;
          },
          (error: unknown) => {
            update({
              ...current,
              pending: null,
              ...renameError(error, current.kind),
            });
            return false;
          },
        );
      update({ ...current, pending, error: null });
      return pending;
    },
    [update],
  );

  const start = useCallback(
    async (args: SidebarRenameArgs & { ownerKey: string }) => {
      const request = ++startRequestRef.current;
      const current = sessionRef.current;
      if (
        current?.ownerKey === args.ownerKey &&
        current.kind === args.kind &&
        current.id === args.id
      )
        return;
      if (current && !(await save())) return;
      if (request !== startRequestRef.current) return;
      update({
        ...args,
        draft: args.name,
        pending: null,
        error: null,
        cannotRetry: false,
      });
    },
    [save, update],
  );

  const cancel = useCallback(() => {
    if (sessionRef.current?.pending) return;
    ++startRequestRef.current;
    update(null);
  }, [update]);

  return {
    session,
    start,
    save,
    cancel,
    change: (draft: string) => {
      const current = sessionRef.current;
      if (current && !current.pending) {
        update({ ...current, draft, error: null, cannotRetry: false });
      }
    },
  };
}

type RenameController = ReturnType<typeof useRenameController>;
const SidebarRenameContext = createContext<RenameController | null>(null);

export function SidebarRenameProvider({ children }: { children: ReactNode }) {
  const controller = useRenameController();
  return (
    <SidebarRenameContext.Provider value={controller}>
      {children}
    </SidebarRenameContext.Provider>
  );
}

export function useSidebarRenameState() {
  return useContext(SidebarRenameContext)?.session ?? null;
}

export function useSidebarRename(args: SidebarRenameArgs) {
  const pendingMenuRename = useRef<(() => void) | null>(null);
  const shared = useContext(SidebarRenameContext);
  const local = useRenameController();
  const controller = shared ?? local;
  const generatedOwnerKey = useId();
  const ownerKey = args.ownerKey ?? generatedOwnerKey;
  const { session, start, cancel } = controller;
  const isEditing =
    session?.ownerKey === ownerKey &&
    session.kind === args.kind &&
    session.id === args.id;
  const startEditing = useCallback(() => {
    void start({ ...args, ownerKey });
  }, [args, start, ownerKey]);

  useEffect(() => {
    if (
      !shared &&
      session &&
      (session.kind !== args.kind || session.id !== args.id)
    ) {
      cancel();
    }
  }, [args.id, args.kind, cancel, session, shared]);

  return {
    editor: isEditing ? (
      <SidebarRenameEditor
        key={session.ownerKey}
        session={session}
        controller={controller}
      />
    ) : null,
    isEditing,
    startEditing,
    startEditingFromMenu: () => {
      pendingMenuRename.current = startEditing;
    },
    onCloseAutoFocus: (event: Event) => {
      const begin = pendingMenuRename.current;
      if (begin) {
        pendingMenuRename.current = null;
        event.preventDefault();
        begin();
      }
    },
  };
}

function readHttpError(error: unknown) {
  if (typeof error !== "object" || error === null) return null;
  const status =
    "status" in error && typeof error.status === "number" ? error.status : null;
  const code =
    "code" in error && typeof error.code === "string" ? error.code : null;
  return status === null && code === null ? null : { status, code };
}

function renameError(error: unknown, kind: RenameSession["kind"]) {
  const http = readHttpError(error);
  if (http !== null) {
    if (
      http.code === "section_name_conflict" ||
      (kind === "section" && http.status === 409)
    ) {
      return {
        error: "A section with this name already exists.",
        cannotRetry: false,
      };
    }
    if (http.status === 404 || http.status === 410) {
      return { error: "This item no longer exists.", cannotRetry: true };
    }
    if (http.status === 401 || http.status === 403) {
      return {
        error: "You do not have permission to rename this item.",
        cannotRetry: true,
      };
    }
  }
  return { error: "Could not save the name. Try again.", cannotRetry: false };
}

function SidebarRenameEditor({
  session,
  controller,
}: {
  session: RenameSession;
  controller: RenameController;
}) {
  const isPending = Boolean(session.pending);
  const inputRef = useRef<HTMLInputElement>(null);
  const groupRef = useRef<HTMLSpanElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(false);
  const composingRef = useRef(false);
  const openingRef = useRef(true);
  const errorId = useId();

  useEffect(() => {
    const input = inputRef.current;
    const row = input?.closest("[data-sidebar-rename-row]");
    anchorRef.current =
      row?.querySelector<HTMLElement>("[data-sidebar-rename-anchor]") ?? null;
    const frame = requestAnimationFrame(() => {
      input?.focus({ preventScroll: true });
      input?.select();
      openingRef.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const restoreFocus = () => {
    const anchor = anchorRef.current;
    requestAnimationFrame(() => {
      if (
        anchor?.isConnected &&
        (document.activeElement === document.body ||
          groupRef.current?.contains(document.activeElement))
      ) {
        anchor.focus({ preventScroll: true });
      }
    });
  };

  const submit = async (restore: boolean, clear = false) => {
    restoreFocusRef.current = restore;
    const input = inputRef.current;
    input?.setSelectionRange(input.value.length, input.value.length);
    const saved = await controller.save(clear);
    if (saved && restoreFocusRef.current) restoreFocus();
  };

  const cancel = (restore: boolean) => {
    if (isPending) return;
    controller.cancel();
    if (restore) restoreFocus();
  };

  return (
    <span
      ref={groupRef}
      data-sidebar-rename-editor=""
      className="relative z-50 flex min-w-0 flex-1 items-center gap-1"
      aria-busy={isPending}
      onBlur={(event) => {
        if (
          openingRef.current ||
          event.currentTarget.contains(event.relatedTarget)
        )
          return;
        restoreFocusRef.current = false;
        if (!isPending) void submit(false);
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
          cancel(true);
        } else if (event.key === "Enter" && event.target === inputRef.current) {
          event.preventDefault();
          void submit(true);
        }
      }}
    >
      <input
        ref={inputRef}
        aria-label={session.label}
        aria-invalid={Boolean(session.error)}
        aria-describedby={session.error ? errorId : undefined}
        autoCapitalize="sentences"
        autoCorrect="off"
        className={cn(
          "min-w-0 flex-1 appearance-none border-0 bg-transparent px-0 py-0 [font:inherit] outline-none",
          session.inputClassName,
          isPending && "animate-shine motion-reduce:opacity-60",
        )}
        spellCheck={false}
        value={session.draft}
        placeholder={session.placeholder}
        readOnly={isPending || session.cannotRetry}
        onChange={(event) => controller.change(event.target.value)}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
      />
      {isPending && (
        <span role="status" aria-label="Saving name" className="sr-only">
          Saving name
        </span>
      )}
      {session.onClear && session.name && (
        <button
          type="button"
          aria-label="Clear custom name"
          disabled={isPending || session.cannotRetry}
          className={cn(
            SIDEBAR_CONTROL_BUTTON_CLASS,
            "inline-flex items-center justify-center disabled:opacity-50",
          )}
          onClick={(event) => {
            void submit(event.detail === 0, true);
          }}
        >
          <Icon name="RotateCcw" className="size-4" />
        </button>
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
  );
}
