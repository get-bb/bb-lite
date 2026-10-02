import { findLocalPathProjectSourceForHost } from "@bb/domain";
import type { ProjectResponse } from "@bb/server-contract";
import { useNavigate } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  ActionMenuItem,
  ActionMenuSeparator,
} from "@/components/ui/action-menu-items";
import { usePathPickerHost } from "@/hooks/useLocalPathPicker";
import { getSettingsProjectRoutePath } from "@/lib/route-paths";
import { useProjectActions } from "./ProjectActionsProvider";

export function ProjectActionsMenu({
  project,
  triggerClassName,
}: {
  project: ProjectResponse;
  triggerClassName?: string;
}) {
  const navigate = useNavigate();
  const { hostId: pickerHostId } = usePathPickerHost();
  const actions = useProjectActions();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "rounded-md p-0 text-muted-foreground",
            triggerClassName,
            "data-[state=open]:bg-state-active data-[state=open]:text-foreground",
          )}
          aria-label={`${project.name} actions`}
          onClick={(event) => event.stopPropagation()}
        >
          <Icon name="MoreHorizontal" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onClick={(event) => event.stopPropagation()}
      >
        <ActionMenuItem
          surface="dropdown"
          icon="Settings"
          onSelect={() => navigate(getSettingsProjectRoutePath(project.id))}
        >
          Project settings
        </ActionMenuItem>
        <ActionMenuItem
          surface="dropdown"
          icon="Edit"
          onSelect={() => actions.requestRename(project)}
        >
          Rename
        </ActionMenuItem>
        {pickerHostId != null &&
        !findLocalPathProjectSourceForHost(project.sources, pickerHostId) ? (
          <ActionMenuItem
            surface="dropdown"
            icon="FolderPlus"
            onSelect={() => actions.requestAddLocalPath(project)}
          >
            Add local path
          </ActionMenuItem>
        ) : null}
        <ActionMenuSeparator surface="dropdown" />
        <ActionMenuItem
          surface="dropdown"
          icon="Trash2"
          variant="destructive"
          onSelect={() => actions.requestDelete(project)}
        >
          Remove
        </ActionMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
