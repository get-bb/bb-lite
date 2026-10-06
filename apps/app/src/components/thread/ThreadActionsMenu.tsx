import {
  ActionMenuItem,
  ActionMenuSeparator,
} from "@/components/ui/action-menu-items";
import type { Thread } from "@bb/domain";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { Button } from "@bb/shared-ui/button";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { cn } from "@bb/shared-ui/lib/utils";
import { isThreadRead } from "@bb/client-core";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { getThreadRoutePath } from "@/lib/route-paths";
import { useThreadActions } from "./ThreadActionsProvider";

export interface ThreadActionsMenuResponsiveAction {
  icon: IconName;
  label: string;
  onSelect: () => void | Promise<void>;
}

function ThreadSectionMoveMenu({
  drawerStep = false,
  isDrawer,
  onBack,
  onOpenDrawerStep,
  thread,
}: {
  drawerStep?: boolean;
  isDrawer: boolean;
  onBack?: () => void;
  onOpenDrawerStep?: () => void;
  thread: Thread;
}) {
  const { sectionDestinations, moveToSection } = useThreadActions();
  const isCurrent = (sectionId: string | null) =>
    thread.pinnedAt === null && thread.sectionId === sectionId;
  if (
    thread.parentThreadId !== null ||
    thread.archivedAt !== null ||
    sectionDestinations.every(({ sectionId }) => isCurrent(sectionId))
  ) {
    return null;
  }
  const items = sectionDestinations.map(({ sectionId, label }) => (
    <DropdownMenuItem
      key={sectionId ?? "threads"}
      aria-current={isCurrent(sectionId) ? "true" : undefined}
      className="flex items-center justify-between gap-3"
      disabled={isCurrent(sectionId)}
      onSelect={() => moveToSection(thread, sectionId)}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {isCurrent(sectionId) ? (
        <Icon name="Check" className="ml-auto" aria-hidden="true" />
      ) : null}
    </DropdownMenuItem>
  ));
  if (isDrawer) {
    if (!drawerStep) {
      return (
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            onOpenDrawerStep?.();
          }}
        >
          <Icon name="SectionMove" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">Move to section</span>
          <Icon name="ChevronRight" className="ml-auto" aria-hidden="true" />
        </DropdownMenuItem>
      );
    }
    return (
      <>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            onBack?.();
          }}
        >
          <Icon name="ChevronLeft" aria-hidden="true" />
          Back
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Move to section</DropdownMenuLabel>
        {items}
      </>
    );
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Icon name="SectionMove" aria-hidden="true" />
        Move to section
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-[min(24rem,calc(100vh-2rem))] min-w-44 overflow-y-auto">
        {items}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function ThreadActionsMenu({
  thread,
  responsiveActions = [],
  triggerClassName,
}: {
  thread: Thread;
  triggerClassName?: string;
  responsiveActions?: readonly ThreadActionsMenuResponsiveAction[];
}) {
  const actions = useThreadActions();
  const isDrawer = useIsCompactViewport();
  const [compactStep, setCompactStep] = useState<"actions" | "move">("actions");
  const isRead = isThreadRead(thread);
  const isArchived = thread.archivedAt != null;
  const isPinned = thread.pinnedAt !== null;
  const afterMenuCloses = (run: (thread: Thread) => void) => () => {
    window.setTimeout(() => run(thread), 0);
  };
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) setCompactStep("actions");
      }}
    >
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
      <DropdownMenuContent align="end">
        {isDrawer && compactStep === "move" ? (
          <ThreadSectionMoveMenu
            drawerStep
            isDrawer
            onBack={() => setCompactStep("actions")}
            thread={thread}
          />
        ) : (
          <>
            {responsiveActions.map((action) => (
              <ActionMenuItem
                key={action.label}
                icon={action.icon}
                onSelect={() => {
                  void action.onSelect();
                }}
              >
                {action.label}
              </ActionMenuItem>
            ))}
            {responsiveActions.length > 0 && !isDrawer ? (
              <ActionMenuSeparator />
            ) : null}
            <ActionMenuItem
              icon="Copy"
              onSelect={() => {
                void copyToClipboardWithToast(
                  new URL(
                    getThreadRoutePath({
                      projectId: thread.projectId,
                      threadId: thread.id,
                    }),
                    window.location.origin,
                  ).toString(),
                  {
                    successMessage: "Thread link copied",
                    errorMessage: "Failed to copy thread link",
                  },
                );
              }}
            >
              Copy thread link
            </ActionMenuItem>
            <ActionMenuItem
              icon={isRead ? "Mail" : "MailOpen"}
              onSelect={() => actions.toggleRead(thread)}
            >
              {isRead ? "Mark unread" : "Mark read"}
            </ActionMenuItem>
            <ActionMenuItem
              icon={isPinned ? "PinOff" : "Pin"}
              onSelect={() => actions.togglePin(thread)}
            >
              {isPinned ? "Unpin" : "Pin"}
            </ActionMenuItem>
            <ThreadSectionMoveMenu
              isDrawer={isDrawer}
              onOpenDrawerStep={() => setCompactStep("move")}
              thread={thread}
            />
            <ActionMenuItem
              icon="Edit"
              onSelect={afterMenuCloses(actions.requestRename)}
            >
              Rename
            </ActionMenuItem>
            {isDrawer ? null : <ActionMenuSeparator />}
            <ActionMenuItem
              icon={isArchived ? "ArchiveRestore" : "Archive"}
              onSelect={
                isArchived
                  ? () => actions.unarchiveThread(thread)
                  : afterMenuCloses(actions.requestArchive)
              }
            >
              {isArchived ? "Unarchive" : "Archive"}
            </ActionMenuItem>
            <ActionMenuItem
              icon="Trash2"
              variant="destructive"
              onSelect={afterMenuCloses(actions.requestDelete)}
            >
              Delete
            </ActionMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
