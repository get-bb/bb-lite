import { useEffect, useState } from "react";
import type { Host } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Icon } from "@bb/shared-ui/icon";
import type { ResourceOverflowMenuItem } from "@bb/shared-ui/resource-list";
import { MachineLaunchCommand } from "@/components/dialogs/AddMachineDialog";
import { ConfirmDeleteDialog } from "@bb/shared-ui/confirm-delete-dialog";
import { RenameDialog } from "@/components/dialogs/RenameDialog";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import {
  useReconnectHost,
  useRemoveHost,
  useRenameHost,
} from "@/hooks/mutations/host-mutations";
import { useMachineThreadPreview } from "@/hooks/queries/thread-queries";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { formatRelativeTime } from "@/lib/relative-time";
import { getThreadDisplayTitle } from "@/lib/thread-title";

export const SERVER_MACHINE_REMOVE_DISABLED_REASON =
  "The server machine can't be removed.";

export function machineRemovalConsequences(host: Host): string {
  return host.machineProviderId !== null
    ? "The provider cleans up resources it owns. Its environments remain as read-only history."
    : "Project checkouts stay on its disk, but its environments become read-only history and it cannot run new work until paired again.";
}

export function machineStatusLabel(host: Host): string {
  const connected = host.status === "connected";
  const detail =
    host.lifecycle.message ??
    (connected || host.lastSeenAt === null
      ? null
      : `last seen ${formatRelativeTime({ timestamp: host.lastSeenAt, now: Date.now() })}`);
  const status = connected ? "Online" : "Offline";
  return detail === null ? status : `${status} · ${detail}`;
}

function MachineRenameDialog({
  target,
  onClose,
}: {
  target: Host | null;
  onClose: () => void;
}) {
  const renameHost = useRenameHost();
  return (
    <RenameDialog
      target={target && { key: target.id, name: target.name }}
      entityLabel="machine"
      description={`Choose a new name for ${target?.name}.`}
      maxLength={100}
      pending={renameHost.isPending}
      errorMessage={
        renameHost.isError
          ? getMutationErrorMessage({
              error: renameHost.error,
              fallbackMessage: "Couldn't rename the machine.",
            })
          : null
      }
      onOpenChange={(open) => {
        if (open || renameHost.isPending) return;
        renameHost.reset();
        onClose();
      }}
      onRename={(name) =>
        target &&
        renameHost.mutate({ hostId: target.id, name }, { onSuccess: onClose })
      }
    />
  );
}

function MachineThreadPreviewList({ hostId }: { hostId: string }) {
  const preview = useMachineThreadPreview({ hostId, limit: 5 }).data;
  if (preview === undefined || preview.total === 0) return null;
  const hiddenCount = preview.total - preview.threads.length;
  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      <p>
        {preview.total === 1
          ? "1 unarchived thread on this machine:"
          : `${preview.total} unarchived threads on this machine:`}
      </p>
      <ul className="list-disc space-y-0.5 pl-5 text-foreground marker:text-subtle-foreground">
        {preview.threads.map((thread) => (
          <li key={thread.id}>
            <span className="block truncate">
              {getThreadDisplayTitle(thread)}
            </span>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 ? <p>and {hiddenCount} more</p> : null}
    </div>
  );
}

function MachineRemoveDialog({
  target,
  onClose,
  onRemoved,
}: {
  target: Host | null;
  onClose: () => void;
  onRemoved?: () => void;
}) {
  const removeHost = useRemoveHost();
  return (
    <ConfirmDeleteDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (open || removeHost.isPending) return;
        removeHost.reset();
        onClose();
      }}
    >
      {target === null ? null : (
        <>
          <DialogHeader>
            <DialogTitle>Remove {target.name}?</DialogTitle>
            <DialogDescription>
              This revokes {target.name}'s access to this server.{" "}
              {machineRemovalConsequences(target)}
            </DialogDescription>
          </DialogHeader>
          <MachineThreadPreviewList hostId={target.id} />
          {removeHost.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {getMutationErrorMessage({
                error: removeHost.error,
                fallbackMessage: `Couldn't remove ${target.name}.`,
              })}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="destructive"
              disabled={removeHost.isPending}
              onClick={() =>
                removeHost.mutate(target.id, {
                  onSuccess: () => {
                    onClose();
                    onRemoved?.();
                  },
                })
              }
            >
              Remove machine
            </Button>
          </DialogFooter>
        </>
      )}
    </ConfirmDeleteDialog>
  );
}

function MachineReconnectDialog({
  target,
  onClose,
}: {
  target: Host | null;
  onClose: () => void;
}) {
  const { mutate, reset, data, isError, error } = useReconnectHost();
  const hostId = target?.id ?? null;
  useEffect(() => {
    if (hostId === null) reset();
    else mutate(hostId);
  }, [hostId, mutate, reset]);
  const errorMessage = isError
    ? getMutationErrorMessage({
        error,
        fallbackMessage: "Couldn't prepare a reconnect command.",
      })
    : null;
  const retry = () => {
    if (hostId !== null) mutate(hostId);
  };
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Reconnect machine</DialogTitle>
          <DialogDescription
            className={
              errorMessage === null ? undefined : "text-destructive-text"
            }
          >
            {errorMessage ??
              `Run this command on ${target?.name ?? "the machine"} to bring it back online. It keeps the machine's projects, environments and history.`}
          </DialogDescription>
        </DialogHeader>
        {errorMessage === null ? null : (
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={retry}>
              Try again
            </Button>
          </div>
        )}
        {data ? (
          <MachineLaunchCommand
            key={data.command}
            command={data.command}
            expiresAt={data.expiresAt}
            onRegenerate={retry}
          />
        ) : null}
        {errorMessage === null ? (
          <div className="flex items-center gap-2.5 rounded-md bg-muted/40 px-3 py-2.5">
            {target?.status === "connected" ? (
              <>
                <MachineStatusDot connected />
                <span
                  role="status"
                  className="min-w-0 flex-1 truncate text-sm text-foreground"
                >
                  {target.name} reconnected
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 px-2 text-xs"
                  onClick={onClose}
                >
                  Done
                </Button>
              </>
            ) : (
              <>
                <Icon
                  name="Spinner"
                  className="size-4 shrink-0 animate-spin text-muted-foreground"
                />
                <span role="status" className="text-sm text-muted-foreground">
                  {data
                    ? "Waiting for the machine to reconnect…"
                    : "Preparing a reconnect command…"}
                </span>
              </>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function useMachineDialogs(
  hosts: readonly Host[] | undefined,
  onRemoved?: () => void,
) {
  const [open, setOpen] = useState<{
    kind: "rename" | "reconnect" | "remove";
    hostId: string;
  } | null>(null);
  const close = () => setOpen(null);
  const target = (kind: "rename" | "reconnect" | "remove") =>
    (open?.kind === kind
      ? hosts?.find((host) => host.id === open.hostId)
      : null) ?? null;
  return {
    menuItems(
      host: Host,
      isPrimary: boolean,
      removable: boolean,
    ): ResourceOverflowMenuItem[] {
      const show = (kind: "rename" | "reconnect" | "remove") => () =>
        setOpen({ kind, hostId: host.id });
      return [
        { label: "Rename", icon: "Edit", onSelect: show("rename") },
        ...(host.status !== "connected" && host.lifecycle.phase === "active"
          ? [
              {
                label: "Reconnect",
                icon: "RotateCcw",
                onSelect: show("reconnect"),
              } as const,
            ]
          : []),
        ...(removable
          ? [
              {
                label: "Remove machine",
                icon: "Trash2",
                tone: "destructive",
                disabled: isPrimary,
                disabledReason: isPrimary
                  ? SERVER_MACHINE_REMOVE_DISABLED_REASON
                  : undefined,
                onSelect: show("remove"),
              } as const,
            ]
          : []),
      ];
    },
    openRemove: (host: Host) => setOpen({ kind: "remove", hostId: host.id }),
    dialogs: (
      <>
        <MachineRenameDialog target={target("rename")} onClose={close} />
        <MachineReconnectDialog target={target("reconnect")} onClose={close} />
        <MachineRemoveDialog
          target={target("remove")}
          onClose={close}
          onRemoved={onRemoved}
        />
      </>
    ),
  };
}
