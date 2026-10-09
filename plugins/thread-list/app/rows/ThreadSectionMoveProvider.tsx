import { callOp, threads } from "@bb/plugin/app";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { toast } from "sonner";
import {
  buildSidebarEntitySectionId,
  normalizeSidebarSectionOrder,
  type SidebarSectionDefinition,
} from "@bb/client-core";
import {} from "@bb/plugin/app";
import type { SidebarThread } from "../model/thread-tree.js";
import { sidebarManualSectionOrderAtom } from "../preferences.js";

interface ThreadSectionMoveDestination {
  label: string;
  sectionId: string | null;
}

export interface ThreadSectionMoveContextValue {
  destinations: readonly ThreadSectionMoveDestination[];
  moveThread: (thread: SidebarThread, sectionId: string | null) => void;
}

const ThreadSectionMoveContext =
  createContext<ThreadSectionMoveContextValue | null>(null);

export function useThreadSectionMove(): ThreadSectionMoveContextValue | null {
  return useContext(ThreadSectionMoveContext);
}

export function ThreadSectionMoveProvider({
  children,
  sections,
}: {
  children: ReactNode;
  sections: readonly SidebarSectionDefinition[];
}) {
  const storedOrder = useAtomValue(sidebarManualSectionOrderAtom);
  const destinations = useMemo<ThreadSectionMoveDestination[]>(() => {
    const byId = new Map(
      sections.map((section) => [
        buildSidebarEntitySectionId("section", section.id),
        { label: section.name, sectionId: section.id },
      ]),
    );
    return normalizeSidebarSectionOrder({
      storedOrder,
      entitySectionIds: [...byId.keys()],
      legacyEntityAnchor: "sections",
      hasPinnedSection: true,
    }).flatMap<ThreadSectionMoveDestination>((id) => {
      if (id === "threads") return [{ label: "Threads", sectionId: null }];
      const destination = byId.get(id);
      return destination ? [destination] : [];
    });
  }, [sections, storedOrder]);
  const value = useMemo<ThreadSectionMoveContextValue>(
    () => ({
      destinations,
      moveThread: (thread, sectionId) => {
        const threadId = thread.id;
        if (thread.pinnedAt !== null) {
          if (thread.sectionId === sectionId) {
            void callOp(threads.unpin, { threadId }).catch(() => {
              toast.error("Failed to unpin thread.");
            });
            return;
          }
          void callOp(threads.unpin, { threadId })
            .then(() => callOp(threads.update, { threadId, sectionId }))
            .catch(() => {
              toast.error("Failed to unpin and move thread.");
            });
          return;
        }
        if (thread.sectionId === sectionId) return;
        void callOp(threads.update, { threadId, sectionId }).catch(() => {
          toast.error("Failed to move thread.");
        });
      },
    }),
    [destinations],
  );

  return (
    <ThreadSectionMoveContext.Provider value={value}>
      {children}
    </ThreadSectionMoveContext.Provider>
  );
}
