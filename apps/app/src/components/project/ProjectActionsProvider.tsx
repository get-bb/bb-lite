import { createContext, useContext, useState, type ReactNode } from "react";
import { useSetAtom } from "jotai";
import { useNavigate } from "react-router-dom";
import type { ProjectResponse } from "@bb/server-contract";
import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "@bb/shared-ui/confirm-delete-dialog";
import { ProjectPathDialog } from "@/components/dialogs/ProjectPathDialog";
import { RenameDialog } from "@/components/dialogs/RenameDialog";
import { collapsedProjectIdsAtom } from "@/components/sidebar/sidebarCollapsedAtoms";
import {
  useAddLocalProjectSource,
  useDeleteProject,
  useUpdateProject,
} from "@/hooks/mutations/project-mutations";
import { useLocalPathPicker } from "@/hooks/useLocalPathPicker";
import { useRouteState } from "@/hooks/useRouteState";
import { getRootComposeRoutePath } from "@/lib/route-paths";

type ProjectActions = Record<
  "requestRename" | "requestDelete" | "requestAddLocalPath",
  (project: ProjectResponse) => void
>;

const ProjectActionsContext = createContext<ProjectActions | null>(null);

export function useProjectActions(): ProjectActions {
  const value = useContext(ProjectActionsContext);
  if (!value) {
    throw new Error(
      "useProjectActions must be used within a <ProjectActionsProvider>",
    );
  }
  return value;
}

export function ProjectActionsProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { projectId: routeProjectId } = useRouteState();
  const setCollapsedProjectIds = useSetAtom(collapsedProjectIdsAtom);
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();
  const addLocalSource = useAddLocalProjectSource();
  const [renameTarget, setRenameTarget] = useState<ProjectResponse | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<ProjectResponse | null>(
    null,
  );
  const picker = useLocalPathPicker({
    isPending: addLocalSource.isPending,
    submit: ({ path, hostId, target, closeDialog }) => {
      if (target.kind !== "add-source") return;
      addLocalSource.mutate(
        { projectId: target.projectId, path, hostId },
        { onSuccess: closeDialog },
      );
    },
  });
  const actions: ProjectActions = {
    requestRename: setRenameTarget,
    requestDelete: setDeleteTarget,
    requestAddLocalPath: (project) =>
      picker.openPicker({
        kind: "add-source",
        projectId: project.id,
        projectName: project.name,
      }),
  };
  return (
    <ProjectActionsContext.Provider value={actions}>
      {children}
      <RenameDialog
        target={
          renameTarget && { key: renameTarget.id, name: renameTarget.name }
        }
        entityLabel="project"
        autoCapitalize="words"
        pending={updateProject.isPending}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
        onRename={(name) =>
          renameTarget &&
          updateProject.mutate(
            { id: renameTarget.id, name },
            { onSuccess: () => setRenameTarget(null) },
          )
        }
      />
      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        {deleteTarget ? (
          <ConfirmDeleteDialogContent
            title="Remove project?"
            description={`Remove "${deleteTarget.name}" and all of its threads? This cannot be undone.`}
            confirmLabel="Remove project"
            pending={deleteProject.isPending}
            onConfirm={() =>
              deleteProject.mutate(deleteTarget.id, {
                onSuccess: () => {
                  setDeleteTarget(null);
                  setCollapsedProjectIds((current) =>
                    current.filter((id) => id !== deleteTarget.id),
                  );
                  if (routeProjectId === deleteTarget.id) {
                    navigate(getRootComposeRoutePath(), { replace: true });
                  }
                },
              })
            }
          />
        ) : null}
      </ConfirmDeleteDialog>
      <ProjectPathDialog
        target={picker.projectPathDialog.target}
        pending={addLocalSource.isPending}
        hostId={picker.hostId}
        hostName={picker.hostName}
        onOpenChange={picker.projectPathDialog.onOpenChange}
        onSubmit={picker.submitProjectPath}
      />
    </ProjectActionsContext.Provider>
  );
}
