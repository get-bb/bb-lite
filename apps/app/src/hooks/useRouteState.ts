import { useLocation, useMatch } from "react-router-dom";
import { PERSONAL_PROJECT_ID } from "@bb/domain";

export function useRouteState() {
  const isRootView = useLocation().pathname === "/";
  const routeProjectId = useMatch("/projects/:projectId/*")?.params.projectId;
  const projectThread = useMatch("/projects/:projectId/threads/:threadId/*");
  const projectlessThreadId = useMatch("/threads/:threadId/*")?.params.threadId;
  const isArchivedView = useMatch("/archived") !== null;
  const isUnsupportedPersonalProjectThread =
    projectThread?.params.projectId === PERSONAL_PROJECT_ID;
  const projectThreadId = isUnsupportedPersonalProjectThread
    ? undefined
    : projectThread?.params.threadId;
  return {
    projectId:
      projectlessThreadId !== undefined || isArchivedView
        ? PERSONAL_PROJECT_ID
        : isUnsupportedPersonalProjectThread
          ? undefined
          : routeProjectId,
    threadId: projectlessThreadId ?? projectThreadId,
    isThreadView:
      projectlessThreadId !== undefined ||
      (projectThread !== null && !isUnsupportedPersonalProjectThread),
    isRootView,
  };
}
