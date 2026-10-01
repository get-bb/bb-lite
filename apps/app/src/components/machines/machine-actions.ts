import type { Host } from "@bb/domain";
import type { ResourceOverflowMenuItem } from "@bb/shared-ui/resource-list";
import { SERVER_MACHINE_REMOVE_DISABLED_REASON } from "@/components/machines/MachineRemoveDialog";
import { canReconnectMachine } from "@/components/machines/machine-status";

export type MachineActionId = "rename" | "reconnect" | "remove";

export type MachineAction = Extract<
  ResourceOverflowMenuItem,
  { onSelect: () => void }
> & { id: MachineActionId };

export interface MachineActionsArgs {
  host: Host;
  isPrimary: boolean;
  onRename: () => void;
  onReconnect: () => void;
  onRemove?: () => void;
}

export function machineActions(args: MachineActionsArgs): MachineAction[] {
  const actions: MachineAction[] = [
    { id: "rename", label: "Rename", icon: "Edit", onSelect: args.onRename },
  ];

  if (canReconnectMachine(args.host))
    actions.push({
      id: "reconnect",
      label: "Reconnect",
      icon: "RotateCcw",
      onSelect: args.onReconnect,
    });

  const onRemove = args.onRemove;
  if (onRemove !== undefined)
    actions.push({
      id: "remove",
      label: "Remove machine",
      icon: "Trash2",
      tone: "destructive",
      ...(args.isPrimary
        ? {
            disabled: true,
            disabledReason: SERVER_MACHINE_REMOVE_DISABLED_REASON,
          }
        : {}),
      onSelect: onRemove,
    });

  return actions;
}
