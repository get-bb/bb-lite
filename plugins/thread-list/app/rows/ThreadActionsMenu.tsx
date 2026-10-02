import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@bb/shared-ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { Button } from "@bb/shared-ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { copyTextToClipboard } from "@bb/shared-ui/lib/clipboard";
import { cn } from "@bb/shared-ui/lib/utils";
import { useSidebarThreadActions, useSdk } from "@bb/plugin/app";
import {
  ActionMenuItem,
  ActionMenuSeparator,
  type ActionMenuSurface,
} from "../ui/action-menu-items.js";
import type { SidebarThread } from "../model/thread-tree.js";
import {
  useThreadSectionMove,
  type ThreadSectionMoveContextValue,
} from "./ThreadSectionMoveProvider.js";

interface ThreadActionsMenuBaseProps {
  thread: SidebarThread;
  onOpenInSplit?: () => void;
  onRename: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}

interface ThreadActionsMenuProps extends ThreadActionsMenuBaseProps {
  onOpenChange?: (open: boolean) => void;
  triggerClassName?: string;
}

interface ThreadActionsContextMenuProps extends ThreadActionsMenuBaseProps {
  children: ReactNode;
  disabled?: boolean;
  dragging?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function useUnarchiveThread(): (threadId: string) => Promise<boolean> {
  const sdk = useSdk();
  return useCallback(
    async (threadId: string) => {
      try {
        await sdk.threads.unarchive({ threadId });
        return true;
      } catch {
        toast.error("Failed to unarchive thread.");
        return false;
      }
    },
    [sdk],
  );
}

function canMoveThreadToSection(
  sectionMove: ThreadSectionMoveContextValue | null,
  thread: SidebarThread,
): sectionMove is ThreadSectionMoveContextValue {
  return (
    sectionMove !== null &&
    thread.parentThreadId === null &&
    thread.archivedAt === null &&
    sectionMove.destinations.some(
      (destination) =>
        thread.pinnedAt !== null || thread.sectionId !== destination.sectionId,
    )
  );
}

function ThreadSectionMoveMenu({
  surface,
  thread,
}: {
  surface: ActionMenuSurface;
  thread: SidebarThread;
}) {
  const sectionMove = useThreadSectionMove();
  if (!canMoveThreadToSection(sectionMove, thread)) return null;

  const Item = surface === "context" ? ContextMenuItem : DropdownMenuItem;
  const Sub = surface === "context" ? ContextMenuSub : DropdownMenuSub;
  const SubTrigger =
    surface === "context" ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
  const SubContent =
    surface === "context" ? ContextMenuSubContent : DropdownMenuSubContent;

  return (
    <Sub>
      <SubTrigger>
        <Icon name="SectionMove" aria-hidden="true" />
        Move to section
      </SubTrigger>
      <SubContent className="max-h-[min(24rem,calc(100vh-2rem))] min-w-44 overflow-y-auto">
        {sectionMove.destinations.map((destination) => {
          const isCurrent =
            thread.pinnedAt === null &&
            thread.sectionId === destination.sectionId;
          return (
            <Item
              key={destination.sectionId ?? "threads"}
              aria-current={isCurrent ? "true" : undefined}
              className="flex items-center justify-between gap-3"
              disabled={isCurrent}
              onSelect={() =>
                sectionMove.moveThread(thread, destination.sectionId)
              }
            >
              <span className="min-w-0 flex-1 truncate">
                {destination.label}
              </span>
              {isCurrent ? (
                <Icon name="Check" className="ml-auto" aria-hidden="true" />
              ) : null}
            </Item>
          );
        })}
      </SubContent>
    </Sub>
  );
}

function ThreadActionsMenuItems({
  thread,
  onOpenInSplit,
  onRename,
  surface,
}: ThreadActionsMenuBaseProps & { surface: ActionMenuSurface }) {
  const actions = useSidebarThreadActions();
  const unarchiveThread = useUnarchiveThread();
  const isRead = !thread.isUnread;
  const isPinned = thread.pinnedAt !== null;
  const isArchived = thread.archivedAt != null;

  return (
    <>
      {onOpenInSplit ? (
        <>
          <ActionMenuItem
            surface={surface}
            icon="Columns2"
            onSelect={onOpenInSplit}
          >
            Open in split
          </ActionMenuItem>
          <ActionMenuSeparator surface={surface} />
        </>
      ) : null}
      <ActionMenuItem
        surface={surface}
        icon="Copy"
        onSelect={() => {
          const url = new URL(thread.href, window.location.origin).toString();
          void copyTextToClipboard(url).then((copied) => {
            if (copied) toast.success("Thread link copied");
            else toast.error("Failed to copy thread link");
          });
        }}
      >
        Copy thread link
      </ActionMenuItem>
      <ActionMenuItem
        surface={surface}
        icon={isRead ? "Mail" : "MailOpen"}
        onSelect={() => {
          void actions.setRead(thread.id, !isRead);
        }}
      >
        {isRead ? "Mark unread" : "Mark read"}
      </ActionMenuItem>
      <ActionMenuItem
        surface={surface}
        icon={isPinned ? "PinOff" : "Pin"}
        onSelect={() => {
          void actions.setPinned(thread.id, !isPinned).catch(() => undefined);
        }}
      >
        {isPinned ? "Unpin" : "Pin"}
      </ActionMenuItem>
      <ThreadSectionMoveMenu surface={surface} thread={thread} />
      <ActionMenuItem surface={surface} icon="Edit" onSelect={onRename}>
        Rename
      </ActionMenuItem>
      <ActionMenuSeparator surface={surface} />
      <ActionMenuItem
        surface={surface}
        icon={isArchived ? "ArchiveRestore" : "Archive"}
        onSelect={() => {
          if (isArchived) {
            void unarchiveThread(thread.id);
            return;
          }
          actions.archive(thread.id);
        }}
      >
        {isArchived ? "Unarchive" : "Archive"}
      </ActionMenuItem>
      <ActionMenuItem
        surface={surface}
        icon="Trash2"
        variant="destructive"
        onSelect={() => {
          window.setTimeout(() => {
            actions.requestDelete(thread.id);
          }, 0);
        }}
      >
        Delete
      </ActionMenuItem>
    </>
  );
}

export function ThreadArchiveQuickAction({
  thread,
  className,
}: {
  thread: SidebarThread;
  className?: string;
}) {
  const actions = useSidebarThreadActions();
  const unarchiveThread = useUnarchiveThread();
  const [isRestoring, setIsRestoring] = useState(false);
  const isArchived = thread.archivedAt != null;
  const label = isArchived ? "Unarchive" : "Archive";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn("rounded-md p-0", className)}
          aria-label={`${label} thread`}
          disabled={isRestoring}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (isArchived) {
              setIsRestoring(true);
              void unarchiveThread(thread.id).finally(() => {
                setIsRestoring(false);
              });
              return;
            }
            actions.archive(thread.id);
          }}
        >
          <Icon
            name={isArchived ? "ArchiveRestore" : "Archive"}
            className={COARSE_POINTER_ICON_SIZE_CLASS}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function ThreadActionsMenu({
  thread,
  onOpenInSplit,
  onRename,
  onCloseAutoFocus,
  onOpenChange,
  triggerClassName,
}: ThreadActionsMenuProps) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "rounded-md p-0",
            "data-[state=open]:bg-state-active data-[state=open]:text-foreground",
            triggerClassName,
          )}
          aria-label="Thread actions"
          data-thread-actions-trigger=""
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <Icon
            name="MoreHorizontal"
            className={COARSE_POINTER_ICON_SIZE_CLASS}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={onCloseAutoFocus}>
        <ThreadActionsMenuItems
          thread={thread}
          onOpenInSplit={onOpenInSplit}
          onRename={onRename}
          surface="dropdown"
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ThreadActionsContextMenu({
  children,
  disabled,
  dragging,
  thread,
  onOpenInSplit,
  onOpenChange,
  onRename,
  onCloseAutoFocus,
}: ThreadActionsContextMenuProps) {
  const [open, setOpen] = useState(false);
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen && dragging) return;
      setOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [dragging, onOpenChange],
  );
  useEffect(() => {
    if (dragging && open) handleOpenChange(false);
  }, [dragging, handleOpenChange, open]);

  return (
    <ContextMenu open={open} onOpenChange={handleOpenChange}>
      <ContextMenuTrigger asChild disabled={disabled || dragging}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        aria-label="Thread actions"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <ThreadActionsMenuItems
          thread={thread}
          onOpenInSplit={onOpenInSplit}
          onRename={onRename}
          surface="context"
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}
