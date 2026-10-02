import { useRouteNavigate } from "@/components/ui/app-route-anchor";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";

export function useCreateThreadInEnvironment(args: {
  projectId: string;
  environmentId: string;
  sectionId: string | null;
  pinned: boolean;
}): () => void {
  const navigate = useRouteNavigate();
  const setRootComposeProjectId = useSetRootComposeProjectId();
  const { projectId, environmentId, sectionId, pinned } = args;
  return () => {
    setRootComposeProjectId(projectId);
    navigate(getRootComposeRoutePath(), {
      state: {
        focusPrompt: true,
        reuseEnvironmentId: environmentId,
        placement: { sectionId, pinned },
      },
    });
  };
}
