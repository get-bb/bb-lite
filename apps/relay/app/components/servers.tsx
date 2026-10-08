import { Button } from "@bb/shared-ui/button";
import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "@bb/shared-ui/confirm-delete-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { Pill } from "@bb/shared-ui/pill";
import { useState } from "react";
import type { ServerState, ServerView } from "../../src/dashboard-types.js";
import { post } from "../data";
import { Panel, Problem } from "./shell";
import { useAction } from "./use-action";

const DOT: Record<ServerState, string> = {
  linked: "bg-success",
  running: "bg-success",
  creating: "bg-attention animate-pulse",
  stopped: "bg-muted-foreground/45",
  "signed-out": "bg-muted-foreground/45",
  failed: "bg-destructive",
};
const DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function describe(server: ServerView): string {
  const version = server.version === null ? "" : ` · version ${server.version}`;
  switch (server.state) {
    case "linked":
      return server.clientName === null
        ? "Linked from a machine you run"
        : `Linked from ${server.clientName}`;
    case "signed-out":
      return "Signed out. Run bb connect login on it to link it again";
    case "creating":
      return "Starting for the first time. This takes about a minute";
    case "running":
      return `Running${version}`;
    case "stopped": {
      const { deletesAt } = server;
      const until =
        deletesAt === null
          ? ""
          : `, deleted ${DAY.format(deletesAt)} if unused`;
      return `Asleep${until}${version}`;
    }
    case "failed":
      return `Did not start: ${server.error ?? "unknown error"}`;
  }
}

function ServerRow({
  server,
  baseHost,
}: {
  server: ServerView;
  baseHost: string;
}) {
  const { pending, problem, run } = useAction();
  const [confirming, setConfirming] = useState<"delete" | "update" | null>(
    null,
  );
  const act = (action: string) =>
    run(action, () => post(`/servers/${server.id}/${action}`));
  const settled = server.state === "running" || server.state === "stopped";
  const busy = pending !== null;
  return (
    <li className="px-4 py-3.5">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span
            aria-hidden="true"
            className={cn("size-2 shrink-0 rounded-full", DOT[server.state])}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <a
                href={server.url}
                className="truncate text-sm font-medium underline-offset-4 hover:underline"
              >
                {server.label}
                <span className="font-normal text-muted-foreground">
                  .{baseHost}
                </span>
              </a>
              {server.hosted ? (
                <Pill variant="secondary" size="sm">
                  Hosted
                </Pill>
              ) : null}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground sm:truncate">
              {describe(server)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 pl-5 sm:pl-0">
          {server.update === null ? null : (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setConfirming("update")}
            >
              <Icon name="RotateCcw" />
              Update
            </Button>
          )}
          <Button variant="outline" size="sm" asChild>
            <a href={server.url}>
              Open
              <Icon name="ArrowUpRight" />
            </a>
          </Button>
          {server.hosted ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  disabled={busy}
                  aria-label={`More actions for ${server.label}`}
                >
                  <Icon name={busy ? "Spinner" : "MoreHorizontal"} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                {server.state === "running" ? (
                  <DropdownMenuItem onSelect={() => void act("sleep")}>
                    Put to sleep
                  </DropdownMenuItem>
                ) : null}
                {server.state === "stopped" ? (
                  <DropdownMenuItem onSelect={() => void act("wake")}>
                    Wake
                  </DropdownMenuItem>
                ) : null}
                {settled ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setConfirming("delete")}
                >
                  Delete…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
      <Problem message={problem} />
      <ConfirmDeleteDialog
        open={confirming === "delete"}
        onOpenChange={(open) => setConfirming(open ? "delete" : null)}
      >
        <ConfirmDeleteDialogContent
          title={`Delete ${server.label}?`}
          description="This deletes the server and everything on its disk: threads, worktrees and agent sign-ins. It cannot be undone."
          confirmLabel="Delete server"
          pending={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            void act("delete");
          }}
        />
      </ConfirmDeleteDialog>
      <Dialog
        open={confirming === "update"}
        onOpenChange={(open) => setConfirming(open ? "update" : null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update {server.label}?</DialogTitle>
            <DialogDescription>
              The server restarts on version {server.update}. Its disk is kept,
              but a turn that is running right now is interrupted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirming(null);
                void act("update");
              }}
            >
              Update now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

export function ServerList({
  servers,
  baseHost,
}: {
  servers: ServerView[];
  baseHost: string;
}) {
  if (servers.length === 0) {
    return (
      <Panel className="grid place-items-center gap-2 px-6 py-12 text-center">
        <Icon name="ComputerCloud" className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium">No servers yet</p>
        <p className="max-w-xs text-sm text-muted-foreground">
          Servers you create or link show up here. Servers you are invited to
          open from their own address.
        </p>
      </Panel>
    );
  }
  return (
    <Panel>
      <ul className="divide-y divide-border-hairline">
        {servers.map((server) => (
          <ServerRow key={server.id} server={server} baseHost={baseHost} />
        ))}
      </ul>
    </Panel>
  );
}
