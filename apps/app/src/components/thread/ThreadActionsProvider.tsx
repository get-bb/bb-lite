import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import { useSetAtom } from "jotai";
import { appToast } from "@/components/ui/app-toast";
import {
  closePanesForThreadsAtom,
  type ClosePanesForThreadsResult,
} from "@/lib/split-layout/atoms";
import type { Thread } from "@bb/domain";
import {
  ArchiveThreadConfirmationRequired,
  useArchiveThreadAndChildren,
  useDeleteThread,
  useMarkThreadRead,
  useMarkThreadUnread,
  useMoveThreadToSection,
  usePinThread,
  useUnarchiveThread,
  useUnpinThread,
  useUpdateThread,
} from "@/hooks/mutations/thread-state-mutations";
import { sdk } from "@/lib/sdk";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useRouteState } from "@/hooks/useRouteState";
import { useDialogState } from "@/hooks/useDialogState";
import { showMutationErrorToast } from "@/lib/mutation-errors";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import {
  ThreadRenameDialog,
  type ThreadRenameDialogTarget,
} from "@/components/dialogs/ThreadRenameDialog";
import {
  ThreadDeleteDialog,
  type ThreadDeleteDialogTarget,
} from "@/components/dialogs/ThreadDeleteDialog";
import {
  ThreadArchiveDialog,
  type ThreadArchiveDialogTarget,
} from "@/components/dialogs/ThreadArchiveDialog";
import { ArchivedThreadToastDescription } from "@/components/thread/ArchivedThreadToastDescription";
import { getThreadReadToggleAction } from "@bb/client-core";
import { getRootComposeRoutePath, getThreadRoutePath } from "@/lib/route-paths";
import { useRouteNavigate } from "@/components/ui/app-route-anchor";

export interface ThreadSectionMoveDestination {
  label: string;
  sectionId: string | null;
}

export interface ThreadActionsContextValue {
  requestArchive: (thread: Thread) => void;
  renameThreadAsync: (threadId: string, title: string) => Promise<void>;
  requestRename: (thread: Thread) => void;
  requestDelete: (thread: Thread) => void;
  unarchiveThread: (thread: Thread) => void;
  togglePin: (thread: Thread) => void;
  toggleRead: (thread: Thread) => void;
  sectionDestinations: readonly ThreadSectionMoveDestination[];
  moveToSection: (thread: Thread, sectionId: string | null) => void;
}

const ThreadActionsContext = createContext<ThreadActionsContextValue | null>(
  null,
);

export function useThreadActions(): ThreadActionsContextValue {
  const value = useContext(ThreadActionsContext);
  if (!value) {
    throw new Error(
      "useThreadActions must be used within a <ThreadActionsProvider>",
    );
  }
  return value;
}

function threadRoute(thread: Thread): string {
  return getThreadRoutePath({
    projectId: thread.projectId,
    threadId: thread.id,
  });
}

export function ThreadActionsProvider({
  children,
  sections,
}: {
  children: ReactNode;
  sections: readonly { id: string; name: string }[];
}) {
  const confirmThreadArchive =
    useSystemConfig().data?.generalSettings.confirmThreadArchive ?? true;
  const navigate = useRouteNavigate();
  const { pathname, search, hash } = useLocation();
  const { threadId: viewedThreadId } = useRouteState();
  const viewedRef = useRef({ route: "", threadId: viewedThreadId });
  useEffect(() => {
    viewedRef.current = {
      route: `${pathname}${search}${hash}`,
      threadId: viewedThreadId,
    };
  }, [hash, pathname, search, viewedThreadId]);
  const closePanesForThreads = useSetAtom(closePanesForThreadsAtom);
  const archiveThread = useArchiveThreadAndChildren();
  const { mutate: unarchive } = useUnarchiveThread();
  const { mutate: markRead } = useMarkThreadRead();
  const { mutate: markUnread } = useMarkThreadUnread();
  const { mutate: pin } = usePinThread();
  const { mutate: unpin } = useUnpinThread();
  const deleteThread = useDeleteThread();
  const updateThread = useUpdateThread();
  const { mutateAsync: renameAsync } = useUpdateThread({
    showErrorToast: false,
  });
  const moveThreadToSection = useMoveThreadToSection();
  const renameDialog = useDialogState<ThreadRenameDialogTarget>();
  const deleteDialog = useDialogState<ThreadDeleteDialogTarget>();
  const archiveDialog = useDialogState<ThreadArchiveDialogTarget>();
  const childSummaryAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => childSummaryAbortRef.current?.abort(), []);

  const navigateAfterClose = (
    result: ClosePanesForThreadsResult,
    removedThreadIds: readonly string[],
  ) => {
    const viewed = viewedRef.current.threadId;
    if (result.removedAny && result.focusedRoute !== null) {
      if (result.focusedRoute.threadId !== viewed) {
        navigate(getThreadRoutePath(result.focusedRoute), { replace: true });
      }
    } else if (viewed && removedThreadIds.includes(viewed)) {
      navigate(getRootComposeRoutePath());
    }
  };

  const archive = (thread: Thread, childThreadsConfirmed: boolean) => {
    archiveThread.mutateAsync({ id: thread.id, childThreadsConfirmed }).then(
      ({ archivedThreadIds }) => {
        archiveDialog.onClose();
        const displaced = viewedRef.current.threadId === thread.id;
        const closed = closePanesForThreads(archivedThreadIds);
        const destination = !displaced
          ? null
          : closed.removedAny && closed.focusedRoute !== null
            ? getThreadRoutePath(closed.focusedRoute)
            : getRootComposeRoutePath();
        navigateAfterClose(closed, archivedThreadIds);
        if (destination !== null) viewedRef.current.route = destination;
        const toastId = `thread-archived-${thread.id}`;
        appToast.success("Thread Archived", {
          description: (
            <ArchivedThreadToastDescription
              archivedThreadCount={archivedThreadIds.length}
              threadTitle={getThreadDisplayTitle(thread)}
              onOpenThread={() => {
                navigate(threadRoute(thread));
                appToast.dismiss(toastId);
              }}
            />
          ),
          cancel: {
            label: "Undo",
            onClick: () => {
              const returnToThread =
                destination !== null && viewedRef.current.route === destination;
              for (const id of [...archivedThreadIds].reverse()) {
                unarchive({ id });
              }
              if (returnToThread) navigate(threadRoute(thread));
            },
          },
          duration: 10_000,
          id: toastId,
        });
      },
      (error: unknown) => {
        if (error instanceof ArchiveThreadConfirmationRequired) {
          archiveDialog.onOpen({
            thread,
            childThreadCount: error.childThreadCount,
          });
          return;
        }
        archiveDialog.onClose();
        showMutationErrorToast({
          error,
          fallbackMessage: "Failed to archive thread and children",
          lifecycleOperation: "archive_thread",
        });
      },
    );
  };

  const value: ThreadActionsContextValue = {
    requestArchive: (thread) => archive(thread, !confirmThreadArchive),
    renameThreadAsync: async (id, title) => {
      await renameAsync({ id, title });
    },
    requestRename: (thread) =>
      renameDialog.onOpen({
        id: thread.id,
        currentTitle: getThreadDisplayTitle(thread),
      }),
    requestDelete: (thread) => {
      childSummaryAbortRef.current?.abort();
      const controller = new AbortController();
      childSummaryAbortRef.current = controller;
      sdk.threads
        .childSummary({ signal: controller.signal, threadId: thread.id })
        .then(
          (summary) => {
            if (controller.signal.aborted) return;
            const childThreadCount = summary?.nonDeletedChildCount ?? 0;
            deleteDialog.onOpen(
              childThreadCount > 0 ? { thread, childThreadCount } : { thread },
            );
          },
          (error: unknown) => {
            if (controller.signal.aborted) return;
            showMutationErrorToast({
              error,
              fallbackMessage: "Failed to check thread state",
            });
          },
        );
    },
    unarchiveThread: (thread) => unarchive({ id: thread.id }),
    togglePin: (thread) =>
      (thread.pinnedAt === null ? pin : unpin)({ id: thread.id }),
    toggleRead: (thread) => {
      const unread = getThreadReadToggleAction(thread) === "mark_unread";
      (unread ? markUnread : markRead)(
        { threadId: thread.id },
        {
          onError: (error) =>
            showMutationErrorToast({
              error,
              fallbackMessage: `Failed to mark thread ${unread ? "unread" : "read"}`,
            }),
        },
      );
    },
    sectionDestinations: [
      ...sections.map(({ id, name }) => ({ label: name, sectionId: id })),
      { label: "Threads", sectionId: null },
    ],
    moveToSection: (thread, sectionId) =>
      moveThreadToSection({ thread, sectionId }),
  };

  return (
    <ThreadActionsContext.Provider value={value}>
      {children}
      <ThreadRenameDialog
        target={renameDialog.target}
        pending={updateThread.isPending}
        onOpenChange={renameDialog.onOpenChange}
        onRename={(id, payload) =>
          updateThread.mutate(
            { id, ...payload },
            { onSuccess: renameDialog.onClose },
          )
        }
      />
      <ThreadDeleteDialog
        target={deleteDialog.target}
        pending={deleteThread.isPending}
        onOpenChange={deleteDialog.onOpenChange}
        onDelete={({ thread, childThreadCount }) =>
          deleteThread.mutate(
            { id: thread.id, childThreadsConfirmed: childThreadCount != null },
            {
              onSuccess: () => {
                deleteDialog.onClose();
                navigateAfterClose(closePanesForThreads([thread.id]), [
                  thread.id,
                ]);
              },
            },
          )
        }
      />
      <ThreadArchiveDialog
        target={archiveDialog.target}
        pending={archiveThread.isPending}
        onOpenChange={archiveDialog.onOpenChange}
        onArchive={({ thread }) => archive(thread, true)}
      />
    </ThreadActionsContext.Provider>
  );
}
