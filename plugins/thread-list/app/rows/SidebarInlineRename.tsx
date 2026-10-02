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
import { SidebarRenameEditor, renameError } from "./SidebarRenameEditor.js";

interface SidebarRenameArgs {
  kind: "thread" | "section";
  id: string;
  name: string;
  label: string;
  onSave: (name: string) => Promise<unknown>;
  ownerKey?: string;
}

export interface RenameSession extends SidebarRenameArgs {
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

  const save = useCallback((): Promise<boolean> => {
    const current = sessionRef.current;
    if (!current) return Promise.resolve(false);
    if (current.pending) return current.pending;
    if (current.cannotRetry) return Promise.resolve(false);
    const value = current.draft.trim();
    if (!value) {
      update({ ...current, error: "Name cannot be empty." });
      return Promise.resolve(false);
    }
    if (value === current.name.trim()) {
      update(null);
      return Promise.resolve(true);
    }
    const pending = Promise.resolve()
      .then(() => current.onSave(value))
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
  }, [update]);

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

export type RenameController = ReturnType<typeof useRenameController>;
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
