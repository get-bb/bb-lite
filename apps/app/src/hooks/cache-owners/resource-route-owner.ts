import { useCallback } from "react";
import { useSetAtom } from "jotai";
import { useNavigate } from "react-router-dom";
import type {
  ChangedMessage,
  ProjectChangedMessage,
  ThreadChangedMessage,
} from "@bb/domain";
import { collapsedProjectIdsAtom } from "@/components/sidebar/sidebarCollapsedAtoms";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import { useRouteState } from "../useRouteState";

type DeletedResourceRouteChangeHandler = (message: ChangedMessage) => void;

function isDeletedProjectMessage(
  message: ChangedMessage,
): message is ProjectChangedMessage & { id: string } {
  return (
    message.entity === "project" &&
    message.id !== undefined &&
    message.changes.includes("project-deleted")
  );
}

function isDeletedThreadMessage(
  message: ChangedMessage,
): message is ThreadChangedMessage & { id: string } {
  return (
    message.entity === "thread" &&
    message.id !== undefined &&
    message.changes.includes("thread-deleted")
  );
}

export function useDeletedResourceRouteOwner(): DeletedResourceRouteChangeHandler {
  const navigate = useNavigate();
  const setCollapsedProjectIdList = useSetAtom(collapsedProjectIdsAtom);
  const { projectId: routeProjectId, threadId: routeThreadId } =
    useRouteState();

  return useCallback(
    (message: ChangedMessage) => {
      if (isDeletedProjectMessage(message)) {
        const deletedProjectId = message.id;
        setCollapsedProjectIdList((current) =>
          current.filter((projectId) => projectId !== deletedProjectId),
        );
        if (routeProjectId === deletedProjectId) {
          navigate(getRootComposeRoutePath(), { replace: true });
        }
        return;
      }

      if (!isDeletedThreadMessage(message)) {
        return;
      }
      const deletedThreadId = message.id;
      if (routeThreadId !== deletedThreadId) {
        return;
      }

      navigate(getRootComposeRoutePath());
    },
    [navigate, routeProjectId, routeThreadId, setCollapsedProjectIdList],
  );
}
