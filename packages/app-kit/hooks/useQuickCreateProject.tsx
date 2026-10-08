import { createContext, useContext, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { deriveProjectNameFromPath } from "@bb/domain";
import { useCreateProject } from "./mutations/project-mutations";
import { selectHosts, useHosts } from "./queries/host-queries";
import { useLocalPathPicker } from "./useLocalPathPicker";
import {
  APP_ROOT_ROUTE_PATH,
  getRootComposeRoutePath,
} from "../lib/route-paths";
import { useSetRootComposeProjectId } from "../lib/root-compose-selection";

function useQuickCreateProject() {
  const { mutate, isPending } = useCreateProject();
  const hosts = selectHosts(useHosts().data, "all");
  const navigate = useNavigate();
  const location = useLocation();
  const setRootComposeProjectId = useSetRootComposeProjectId();
  const picker = useLocalPathPicker({
    isPending,
    submit: ({ path, hostId, target, closeDialog }) => {
      const name = deriveProjectNameFromPath(path).trim();
      if (target.kind !== "create" || !name) return;
      mutate(
        { name, source: { type: "local_path", hostId, path } },
        {
          onSuccess: (project) => {
            closeDialog();
            setRootComposeProjectId(project.id);
            void navigate(getRootComposeRoutePath(), {
              replace: location.pathname === APP_ROOT_ROUTE_PATH,
            });
          },
        },
      );
    },
  });
  return {
    isAvailable: picker.isAvailable,
    isCreating: isPending,
    openCreateDialog: () => picker.openPathEntry({ kind: "create" }),
    hostId: picker.hostId,
    hostName: picker.hostName,
    hosts,
    projectPathDialog: picker.projectPathDialog,
    submitProjectPath: picker.submitProjectPath,
  };
}

type QuickCreateProjectController = ReturnType<typeof useQuickCreateProject>;

const QuickCreateProjectContext =
  createContext<QuickCreateProjectController | null>(null);

export function QuickCreateProjectProvider({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <QuickCreateProjectContext.Provider value={useQuickCreateProject()}>
      {children}
    </QuickCreateProjectContext.Provider>
  );
}

export function useQuickCreateProjectController(): QuickCreateProjectController {
  const controller = useContext(QuickCreateProjectContext);
  if (!controller) throw new Error("QuickCreateProjectProvider is required");
  return controller;
}
