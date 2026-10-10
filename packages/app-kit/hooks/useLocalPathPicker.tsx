import { useState } from "react";
import { selectHosts, useHosts, usePrimaryHost } from "./queries/host-queries";
import type {
  ProjectPathDialogSubmitHandler,
  ProjectPathDialogTarget,
} from "../components/dialogs/ProjectPathDialog";

interface LocalPathSubmitParams {
  path: string;
  hostId: string;
  target: ProjectPathDialogTarget;
  closeDialog: () => void;
}

export function useLocalPathPicker({
  isPending,
  submit,
}: {
  isPending: boolean;
  submit: (params: LocalPathSubmitParams) => void;
}) {
  const primaryHost = usePrimaryHost();
  const host = primaryHost?.status === "connected" ? primaryHost : null;
  const hostsQuery = useHosts();
  const [target, setTarget] = useState<ProjectPathDialogTarget | null>(null);
  const openPicker = (next: ProjectPathDialogTarget) => {
    if (!isPending && host) setTarget(next);
  };
  const submitProjectPath: ProjectPathDialogSubmitHandler = (
    submitted,
    path,
    hostId,
  ) => {
    if (isPending || !hostId) return;
    const closeDialog = () => setTarget(null);
    submit({ path, hostId, target: submitted, closeDialog });
  };
  return {
    isAvailable: host !== null,
    hostId: host?.id ?? null,
    hostName: host?.name ?? null,
    openPicker,
    openPathEntry: (next: ProjectPathDialogTarget) => {
      const connected = selectHosts(hostsQuery.data, "all").filter(
        (candidate) => candidate.status === "connected",
      );
      if (hostsQuery.isPending || connected.length > 1) setTarget(next);
      else openPicker(next);
    },
    projectPathDialog: {
      target,
      onOpenChange: (open: boolean) => {
        if (!open) setTarget(null);
      },
    },
    submitProjectPath,
  };
}
