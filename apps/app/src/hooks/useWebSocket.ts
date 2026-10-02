import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import { wsManager } from "@/lib/ws";
import { applyChange, resync } from "./realtime";
import { useRouteState } from "./useRouteState";

export function useWebSocket(): void {
  const client = useQueryClient();
  const navigate = useNavigate();
  const route = useRouteState();
  const routeRef = useRef(route);
  routeRef.current = route;

  useEffect(() => {
    const stopConnected = wsManager.onConnected((reconnected) =>
      resync(client, reconnected),
    );
    const stopChanged = wsManager.onChanged((message) => {
      applyChange(client, message);
      const { changes, entity } = message;
      const { projectId, threadId } = routeRef.current;
      if (entity === "thread" && message.id === threadId) {
        if (changes.includes("thread-deleted")) {
          navigate(getRootComposeRoutePath());
        }
      } else if (entity === "project" && message.id === projectId) {
        if (changes.includes("project-deleted")) {
          navigate(getRootComposeRoutePath(), { replace: true });
        }
      }
    });
    wsManager.connect();
    return () => {
      stopConnected();
      stopChanged();
    };
  }, [client, navigate]);
}
