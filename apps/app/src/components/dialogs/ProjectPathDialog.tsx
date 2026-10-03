import { useState } from "react";
import {
  deriveProjectNameFromPath,
  getProjectPathValidationMessage,
  normalizeProjectPathInput,
  type Host,
} from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
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
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { RemotePathBrowser } from "@/components/dialogs/RemotePathBrowser";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";

export type ProjectPathDialogTarget =
  | { kind: "create" }
  | {
      kind: "update";
      projectId: string;
      projectName: string;
      currentPath: string;
    }
  | { kind: "add-source"; projectId: string; projectName: string };

export type ProjectPathDialogSubmitHandler = (
  target: ProjectPathDialogTarget,
  path: string,
  hostId: string | null,
) => Promise<void> | void;

interface ProjectPathDialogProps {
  target: ProjectPathDialogTarget | null;
  pending?: boolean;
  hostId: string | null;
  hostName: string | null;
  hosts?: readonly Host[];
  onOpenChange: (open: boolean) => void;
  onSubmit: ProjectPathDialogSubmitHandler;
}

const COPY = {
  create: { title: "Add project", submit: "Add project" },
  update: { title: "Update project path", submit: "Save path" },
  "add-source": { title: "Add project source", submit: "Add source" },
};

export function ProjectPathDialog(props: ProjectPathDialogProps) {
  const { target } = props;
  return (
    <Dialog open={target !== null} onOpenChange={props.onOpenChange}>
      <DialogContent>
        {target ? (
          <ProjectPathForm
            key={target.kind === "create" ? "create" : target.projectId}
            {...props}
            target={target}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ProjectPathForm({
  target,
  pending = false,
  hostId,
  hostName,
  hosts,
  onSubmit,
}: ProjectPathDialogProps & { target: ProjectPathDialogTarget }) {
  const machines = target.kind === "create" ? (hosts ?? []) : [];
  const firstConnectedId =
    machines.find((host) => host.status === "connected")?.id ?? null;
  const [pickedHostId, setPickedHostId] = useState(hostId ?? firstConnectedId);
  const selectedHost =
    machines.find(
      (host) => host.id === pickedHostId && host.status === "connected",
    ) ?? machines.find((host) => host.id === firstConnectedId);
  const selectedHostId =
    target.kind === "create" ? (selectedHost?.id ?? null) : pickedHostId;
  const selectedHostName = selectedHost?.name ?? hostName;
  const [directory, setDirectory] = useState<string | null>(
    target.kind === "update" ? target.currentPath : null,
  );
  const [validation, setValidation] = useState<{
    path: string | null;
    message: string;
  } | null>(null);
  const validationMessage =
    validation?.path === directory ? validation.message : null;
  const projectName =
    target.kind === "create" && directory
      ? deriveProjectNameFromPath(directory)
      : "";
  return (
    <>
      <DialogHeader>
        <DialogTitle>{COPY[target.kind].title}</DialogTitle>
        <DialogDescription>
          {selectedHostId
            ? `Browse to the project folder${
                selectedHostName ? ` on ${selectedHostName}` : ""
              }, or edit the path directly.`
            : "No machine is online. Start one to choose a project folder."}
        </DialogDescription>
      </DialogHeader>
      <form
        className="min-w-0 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) return;
          const path = directory && normalizeProjectPathInput(directory);
          const message = !path
            ? "Choose a project folder."
            : (getProjectPathValidationMessage(path) ??
              (target.kind === "create" && !deriveProjectNameFromPath(path)
                ? "Could not derive a project name from that path."
                : null));
          if (!path || message) {
            setValidation({ path: directory, message: message ?? "" });
          } else void onSubmit(target, path, selectedHostId);
        }}
      >
        {machines.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={pending}>
              <Button
                type="button"
                variant="outline"
                aria-label="Machine"
                disabled={pending}
                className="w-full justify-between font-normal"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {selectedHost ? <MachineStatusDot connected /> : null}
                  <span className="min-w-0 truncate">
                    {selectedHost?.name ?? "Select a machine"}
                  </span>
                </span>
                <Icon
                  name="ChevronDown"
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-72 w-[var(--anchor-width)] overflow-y-auto"
            >
              {machines.map((host) => {
                const connected = host.status === "connected";
                return (
                  <DropdownMenuItem
                    key={host.id}
                    disabled={!connected}
                    className="flex items-center gap-2"
                    onSelect={() => {
                      setPickedHostId(host.id);
                      setDirectory(null);
                    }}
                  >
                    <MachineStatusDot connected={connected} />
                    <span className="min-w-0 flex-1 truncate">{host.name}</span>
                    {!connected ? (
                      <span className="shrink-0 text-xs text-subtle-foreground">
                        Offline
                      </span>
                    ) : null}
                    <Icon
                      name="Check"
                      className={cn(
                        "size-4 shrink-0",
                        host.id === selectedHostId
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                    />
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {selectedHostId ? (
          <RemotePathBrowser
            key={selectedHostId}
            hostId={selectedHostId}
            initialPath={target.kind === "update" ? target.currentPath : null}
            onDirectoryChange={setDirectory}
            disabled={pending}
          />
        ) : (
          <p className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
            Every machine is offline. Bring one online to browse its folders.
          </p>
        )}
        {projectName || validationMessage ? (
          <div className="space-y-1">
            {projectName ? (
              <p className="flex min-w-0 gap-1 text-sm text-muted-foreground">
                <span className="shrink-0">Project name:</span>
                <span className="min-w-0 truncate font-medium text-foreground">
                  {projectName}
                </span>
              </p>
            ) : null}
            {validationMessage ? (
              <p className="text-sm text-destructive">{validationMessage}</p>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button
            type="submit"
            disabled={pending || !directory || !selectedHostId}
          >
            {COPY[target.kind].submit}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
