import { nanoid } from "nanoid";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Host } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Icon } from "@bb/shared-ui/icon";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import {
  MachineAccessControls,
  machineServerAccessReady,
} from "@/components/settings/MachineAccessSettings";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useClipboardCopy } from "@/lib/clipboard";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { getSettingsMachineRoutePath } from "@/lib/route-paths";
import { sdk } from "@/lib/sdk";

export function AddMachineDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const hosts = useHosts();
  const close = (next: boolean) => {
    if (!next) void hosts.refetch();
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={close} modal={false}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        {open && <AddMachineContent onClose={() => close(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function AddMachineContent({ onClose }: { onClose: () => void }) {
  const config = useSystemConfig();
  const hosts = useHosts();
  if (machineServerAccessReady(config.data?.serverAccess)) {
    return (
      <MachineSetup
        serverMachineName={
          hosts.data?.find((host) => host.id === config.data?.primaryHostId)
            ?.name ?? null
        }
        onClose={onClose}
      />
    );
  }
  if (config.isPending) {
    return (
      <>
        <DialogTitle className="sr-only">Add a machine</DialogTitle>
        <p role="status" className="text-sm text-subtle-foreground">
          Checking machine access…
        </p>
      </>
    );
  }
  if (config.isError) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Add a machine</DialogTitle>
          <DialogDescription className="text-destructive-text">
            Couldn’t check whether machines can reach this server.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void config.refetch()}
          >
            Try again
          </Button>
        </div>
      </>
    );
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>Set up machine access</DialogTitle>
        <DialogDescription>
          A new machine has to reach this server over the network. Choose the
          address it should use.
        </DialogDescription>
      </DialogHeader>
      <MachineAccessControls />
    </>
  );
}

interface EnrollmentCommand {
  value: string;
  expiresAt: number;
  unavailable: boolean;
}

function MachineSetup({
  serverMachineName,
  onClose,
}: {
  serverMachineName: string | null;
  onClose: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [command, setCommand] = useState<EnrollmentCommand | null>(null);
  const [connectedHost, setConnectedHost] = useState<Host | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let pendingHostId: string | null = null;
    setCommand(null);
    setErrorMessage(null);
    const run = async () => {
      let host = await sdk.hosts.experimental_create({
        key: nanoid(),
        machineProviderId: "manual",
        inputs: null,
        wait: false,
        signal,
      });
      pendingHostId = host.id;
      while (host.lifecycle.phase === "creating") {
        const hostId = host.id;
        const enrollment = await sdk.hosts.experimental_getEnrollmentCommand({
          hostId,
          signal,
        });
        setCommand((previous) =>
          enrollment === null
            ? previous && { ...previous, unavailable: true }
            : {
                value: enrollment.command,
                expiresAt: enrollment.expiresAt,
                unavailable: false,
              },
        );
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        signal.throwIfAborted();
        host = await sdk.hosts.get({ hostId, signal });
      }
      pendingHostId = null;
      if (host.lifecycle.phase !== "active") {
        throw new Error(host.lifecycle.message ?? "Machine setup cancelled");
      }
      setConnectedHost(host);
    };
    run().catch((error: unknown) => {
      if (signal.aborted) return;
      setErrorMessage(
        getMutationErrorMessage({
          error,
          fallbackMessage: "Couldn't prepare an enrollment command.",
        }),
      );
    });
    return () => {
      controller.abort();
      if (pendingHostId !== null) {
        void sdk.hosts.delete({ hostId: pendingHostId }).catch(() => {});
      }
    };
  }, [attempt]);
  const retry = () => setAttempt((current) => current + 1);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Add a machine</DialogTitle>
        <DialogDescription
          className={
            errorMessage === null ? undefined : "text-destructive-text"
          }
        >
          {errorMessage ??
            "Run this command on the machine you want to add. It installs bb and keeps the machine connected to this server."}
        </DialogDescription>
      </DialogHeader>
      {errorMessage === null ? null : (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={retry}>
            Try again
          </Button>
        </div>
      )}
      {command === null ? null : (
        <MachineLaunchCommand
          key={command.value}
          command={command.value}
          expiresAt={command.expiresAt}
          unavailable={command.unavailable}
          onRegenerate={retry}
        />
      )}
      {errorMessage === null ? (
        <>
          <div className="flex items-center gap-2.5 rounded-md bg-muted/40 px-3 py-2.5">
            {connectedHost === null ? (
              <>
                <Icon
                  name="Spinner"
                  className="size-4 shrink-0 animate-spin text-muted-foreground"
                />
                <span role="status" className="text-sm text-muted-foreground">
                  {command === null
                    ? "Preparing an enrollment command…"
                    : "Waiting for the machine to connect…"}
                </span>
              </>
            ) : (
              <>
                <MachineStatusDot connected />
                <span
                  role="status"
                  className="min-w-0 flex-1 truncate text-sm text-foreground"
                >
                  {connectedHost.name} connected
                </span>
                <Button
                  asChild
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 px-2 text-xs"
                >
                  <Link
                    to={getSettingsMachineRoutePath(connectedHost.id)}
                    onClick={onClose}
                  >
                    Open machine
                    <Icon name="ArrowRight" />
                  </Link>
                </Button>
              </>
            )}
          </div>
          <p className="text-xs text-subtle-foreground">
            {serverMachineName === null
              ? "The new machine will connect to your bb server. Keep the server machine on so the new machine can keep working."
              : `The new machine will connect to the bb server on ${serverMachineName}. Keep that computer on so the new machine can keep working.`}
          </p>
        </>
      ) : null}
    </>
  );
}

export function MachineLaunchCommand({
  command,
  expiresAt,
  unavailable = false,
  onRegenerate,
}: {
  command: string;
  expiresAt: number;
  unavailable?: boolean;
  onRegenerate: () => void;
}) {
  const { copied, copy } = useClipboardCopy({ text: command });
  const [remaining, setRemaining] = useState(() => expiresAt - Date.now());
  useEffect(() => {
    const timer = setInterval(
      () => setRemaining(expiresAt - Date.now()),
      1_000,
    );
    return () => clearInterval(timer);
  }, [expiresAt]);
  const expired = remaining <= 0;
  const seconds = Math.max(0, Math.floor(remaining / 1000));
  return (
    <div className="overflow-hidden rounded-md border border-border bg-muted/30">
      <pre className="overflow-x-auto whitespace-pre-wrap break-all p-3 font-mono text-xs text-foreground">
        {command}
      </pre>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
        {unavailable ? (
          <span role="status" className="text-xs text-subtle-foreground">
            Command used
          </span>
        ) : expired ? (
          <>
            <span role="status" className="text-xs text-subtle-foreground">
              Command expired
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={onRegenerate}
            >
              Generate a new command
            </Button>
          </>
        ) : (
          <span
            role="status"
            className="text-xs tabular-nums text-subtle-foreground"
          >
            {`Command expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}
          </span>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ml-auto h-7 px-2.5 text-xs"
          disabled={expired || unavailable}
          onClick={() => void copy()}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
