import {
  ActionMenuItem,
  ActionMenuSeparator,
} from "@/components/ui/action-menu-items";
import type { Thread } from "@bb/domain";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { Button } from "@bb/shared-ui/button";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
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

function ThreadSectionMoveMenu({ thread }: { thread: Thread }) {
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
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Icon name="SectionMove" aria-hidden="true" />
        Move to section
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-[min(24rem,calc(100vh-2rem))] min-w-44 overflow-y-auto">
        {sectionDestinations.map(({ sectionId, label }) => (
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
        ))}
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
  const isRead = isThreadRead(thread);
  const isArchived = thread.archivedAt != null;
  const isPinned = thread.pinnedAt !== null;
  const afterMenuCloses = (run: (thread: Thread) => void) => () => {
    window.setTimeout(() => run(thread), 0);
  };
  return (
    <DropdownMenu>
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
        {responsiveActions.length > 0 ? <ActionMenuSeparator /> : null}
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
        <ThreadSectionMoveMenu thread={thread} />
        <ActionMenuItem
          icon="Edit"
          onSelect={afterMenuCloses(actions.requestRename)}
        >
          Rename
        </ActionMenuItem>
        <ActionMenuSeparator />
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
