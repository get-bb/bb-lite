import { useState } from "react";
import type { ProjectSource } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { RemotePathBrowser } from "@/components/dialogs/RemotePathBrowser";
import { useAddProjectSource } from "@/hooks/mutations/project-mutations";
import { getMutationErrorMessage } from "@/lib/mutation-errors";

export interface ProjectMachineSetupDialogTarget {
  projectId: string;
  projectName: string;
  gitRemoteUrl: string | null;
  hostId: string;
  hostName: string;
}

export interface ProjectMachineSetupCompletion {
  hostId: string;
  source: ProjectSource;
}

export function ProjectMachineSetupDialog({
  target,
  onOpenChange,
  onComplete,
}: {
  target: ProjectMachineSetupDialogTarget | null;
  onOpenChange: (open: boolean) => void;
  onComplete: (completion: ProjectMachineSetupCompletion) => void;
}) {
  const addSource = useAddProjectSource();
  const [folder, setFolder] = useState<string | null>(null);
  const pending = addSource.isPending;
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (open || pending) return;
        addSource.reset();
        onOpenChange(false);
      }}
    >
      <DialogContent>
        {target ? (
          <>
            <DialogHeader>
              <DialogTitle>
                Set up {target.projectName} on {target.hostName}
              </DialogTitle>
              <DialogDescription>
                {`${target.hostName} doesn't have this project yet. Point at the project folder on ${target.hostName} — this happens once.`}
              </DialogDescription>
            </DialogHeader>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (pending || folder === null) return;
                const { projectId, hostId } = target;
                addSource.mutate(
                  {
                    projectId,
                    request: { type: "local_path", hostId, path: folder },
                  },
                  {
                    onSuccess: (source) => {
                      addSource.reset();
                      onComplete({ hostId, source });
                    },
                  },
                );
              }}
            >
              <RemotePathBrowser
                key={`${target.projectId}:${target.hostId}`}
                hostId={target.hostId}
                onDirectoryChange={setFolder}
                disabled={pending}
              />
              {addSource.isError ? (
                <p className="whitespace-pre-wrap break-words text-sm text-destructive">
                  {getMutationErrorMessage({
                    error: addSource.error,
                    fallbackMessage: `Couldn't set up ${target.projectName} on ${target.hostName}.`,
                  })}
                </p>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={pending || folder === null}>
                  Use folder & continue
                </Button>
              </DialogFooter>
            </form>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
