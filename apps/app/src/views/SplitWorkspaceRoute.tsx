import { useMemo } from "react";
import { disableGlobalCursorStyles } from "react-resizable-panels";
import { matchPath, Navigate, useLocation } from "react-router-dom";
import "@bb/shared-ui/icon-extended";
import {
  APP_ROOT_ROUTE_PATH,
  LEGACY_PROJECT_COMPOSE_ROUTE_PATH,
} from "@/lib/route-paths";
import type { PaneContent } from "@/lib/split-layout";
import { useRouteState } from "@/hooks/useRouteState";
import { LegacyProjectComposeRedirect } from "./RootComposeView";
import { SplitThreadArea } from "./thread-detail/SplitThreadArea";
import { paneContentForPathname } from "./thread-detail/splitThreadNavigation";

disableGlobalCursorStyles();

export default function SplitWorkspaceRoute() {
  const { pathname } = useLocation();
  const { projectId, threadId, isThreadView } = useRouteState();
  const routeContent = useMemo<PaneContent | null>(() => {
    if (isThreadView) {
      return projectId && threadId
        ? { kind: "thread", projectId, threadId }
        : null;
    }
    const content = paneContentForPathname(pathname);
    return content?.kind === "thread" ? null : content;
  }, [isThreadView, pathname, projectId, threadId]);
  const legacyProjectId = matchPath(LEGACY_PROJECT_COMPOSE_ROUTE_PATH, pathname)
    ?.params.projectId;
  if (legacyProjectId) {
    return <LegacyProjectComposeRedirect projectId={legacyProjectId} />;
  }
  if (routeContent === null) {
    return <Navigate to={APP_ROOT_ROUTE_PATH} replace />;
  }
  return <SplitThreadArea routeContent={routeContent} />;
}
