import { useMemo } from "react";
import { useBbNavigate } from "@bb/plugin/app";

export const PANEL_PATH = "tasks";

export type TasksRoute =
  | { kind: "all" | "active" | "manage" }
  | { kind: "project"; projectId: string }
  | { kind: "task"; taskKey: string };

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseTasksRoute(rawSubPath: string): TasksRoute {
  const [path = ""] = rawSubPath
    .split("/")
    .map(decodeSegment)
    .join("/")
    .split("?");
  const [head, taskKey] = path.split("/").filter(Boolean);
  if (head === "active" || head === "manage") return { kind: head };
  if (head === "task")
    return taskKey ? { kind: "task", taskKey } : { kind: "all" };
  if (head === undefined || head === "all") return { kind: "all" };
  return { kind: "project", projectId: head };
}

export function tasksRouteToSubPath(route: TasksRoute): string {
  if (route.kind === "task") return `task/${route.taskKey}`;
  return route.kind === "project" ? route.projectId : route.kind;
}

export interface TasksNavigation {
  go: (route: TasksRoute, options?: { replace?: boolean }) => void;
}

export function useTasksNavigation(): TasksNavigation {
  const navigate = useBbNavigate();
  return useMemo(
    () => ({
      go: (route, options) => {
        navigate.toPluginPanel(PANEL_PATH, {
          subPath: tasksRouteToSubPath(route),
          ...(options?.replace ? { replace: true } : {}),
        });
      },
    }),
    [navigate],
  );
}
