import { useCallback } from "react";
import { useDialogState } from "@/hooks/useDialogState";
import {
  selectHosts,
  useHosts,
  usePrimaryHost,
} from "@/hooks/queries/host-queries";
import type {
  ProjectPathDialogSubmitHandler,
  ProjectPathDialogTarget,
} from "@/components/dialogs/ProjectPathDialog";

export interface LocalPathSubmitParams {
  path: string;
  hostId: string;
  target: ProjectPathDialogTarget;
  closeDialog: () => void;
}

interface UseLocalPathPickerOptions {
  isPending: boolean;
  submit: (params: LocalPathSubmitParams) => void;
}

interface LocalPathPickerController {
  isAvailable: boolean;
  hostId: string | null;
  hostName: string | null;
  openPathEntry: (target: ProjectPathDialogTarget) => void;
  openPicker: (target: ProjectPathDialogTarget) => void;
  projectPathDialog: ReturnType<typeof useDialogState<ProjectPathDialogTarget>>;
  submitProjectPath: ProjectPathDialogSubmitHandler;
}

interface PathPickerHost {
  hostId: string | null;
  hostName: string | null;
}

export function usePathPickerHost(): PathPickerHost {
  const primaryHost = usePrimaryHost();
  const connectedPrimaryHost =
    primaryHost?.status === "connected" ? primaryHost : null;

  return {
    hostId: connectedPrimaryHost?.id ?? null,
    hostName: connectedPrimaryHost?.name ?? null,
  };
}

export function useLocalPathPicker({
  isPending,
  submit,
}: UseLocalPathPickerOptions): LocalPathPickerController {
  const { hostId, hostName } = usePathPickerHost();
  const hostsQuery = useHosts();
  const isLoadingHosts = hostsQuery.isPending;
  const connectedHostCount = selectHosts(hostsQuery.data, "all").filter(
    (host) => host.status === "connected",
  ).length;
  const projectPathDialog = useDialogState<ProjectPathDialogTarget>();
  const closeDialog = projectPathDialog.onClose;

  const submitPath = useCallback(
    (
      path: string,
      target: ProjectPathDialogTarget,
      targetHostId: string | null,
    ) => {
      if (isPending || !targetHostId) return;
      submit({ path, hostId: targetHostId, target, closeDialog });
    },
    [closeDialog, isPending, submit],
  );

  const openPicker = useCallback(
    (target: ProjectPathDialogTarget) => {
      if (isPending || !hostId) return;
      projectPathDialog.onOpen(target);
    },
    [hostId, isPending, projectPathDialog],
  );

  const submitProjectPath = useCallback<ProjectPathDialogSubmitHandler>(
    (target, path, selectedHostId) => {
      submitPath(path, target, selectedHostId);
    },
    [submitPath],
  );

  const openPathEntry = useCallback(
    (target: ProjectPathDialogTarget) => {
      if (isLoadingHosts || connectedHostCount > 1) {
        projectPathDialog.onOpen(target);
        return;
      }
      openPicker(target);
    },
    [connectedHostCount, isLoadingHosts, openPicker, projectPathDialog],
  );

  return {
    isAvailable: hostId != null,
    hostId,
    hostName,
    openPathEntry,
    openPicker,
    projectPathDialog,
    submitProjectPath,
  };
}
