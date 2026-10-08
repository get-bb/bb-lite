import { useCallback, useEffect, useRef, useState } from "react";
import type { ShellNavPanelProps } from "@bb/plugin/app";
import { useOverview } from "./data.js";
import {
  parseTasksRoute,
  useTasksNavigation,
  type TasksRoute,
} from "./routes.js";
import { TasksTopbar } from "./topbar.js";
import { ListView } from "../views/list/index.js";
import { DetailView } from "../views/detail/index.js";
import { NewTaskDialog } from "../views/manage/new-task-dialog.js";
import { NewProjectDialog } from "../views/manage/new-project-dialog.js";
import { LabelsPanel } from "../views/manage/labels.js";
import { EmptyState } from "../components/common.js";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";

function isPlainShortcut(event: KeyboardEvent): boolean {
  const { target } = event;
  const editing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable);
  const overlay = document.querySelector(
    '[role="dialog"], [role="menu"], [role="listbox"]:not([hidden] *)',
  );
  const modified = event.metaKey || event.ctrlKey || event.altKey;
  return !editing && overlay === null && !modified && !event.defaultPrevented;
}

export function TasksAppShell({ subPath }: ShellNavPanelProps) {
  const route = parseTasksRoute(subPath);
  const navigation = useTasksNavigation();
  const overview = useOverview();
  const projects = overview.data?.projects;
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const openNewTask = useCallback(() => setNewTaskOpen(true), []);

  const lastBrowseRoute = useRef<TasksRoute>({ kind: "all" });
  useEffect(() => {
    if (route.kind !== "task") lastBrowseRoute.current = route;
  });
  const taskKey = route.kind === "task" ? route.taskKey : null;
  const backFromTask = useCallback(
    () => navigation.go(lastBrowseRoute.current),
    [navigation],
  );
  const onCanonicalKey = useCallback(
    (canonicalKey: string) => {
      if (canonicalKey.toUpperCase() === taskKey?.toUpperCase()) return;
      navigation.go({ kind: "task", taskKey: canonicalKey }, { replace: true });
    },
    [navigation, taskKey],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPlainShortcut(event)) return;
      if (event.key === "Escape" && taskKey !== null) backFromTask();
      if (event.key !== "c" || event.repeat) return;
      event.preventDefault();
      setNewTaskOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [taskKey, backFromTask]);

  const browsing = route.kind !== "task" && route.kind !== "manage";
  let content: React.ReactNode;
  if (projects?.length === 0 && browsing) {
    content = (
      <EmptyState
        icon="ListTodo"
        title="No projects yet"
        description="Create a project to start tracking tasks and dispatching work to agents."
        action={
          <Button size="sm" onClick={() => setNewProjectOpen(true)}>
            <Icon name="Plus" className="size-3.5" />
            New project
          </Button>
        }
      />
    );
  } else if (route.kind === "task") {
    content = (
      <DetailView
        key={route.taskKey}
        taskKey={route.taskKey}
        onCanonicalKey={onCanonicalKey}
      />
    );
  } else if (route.kind === "manage") {
    content = <LabelsPanel projects={projects ?? []} />;
  } else {
    const projectId = route.kind === "project" ? route.projectId : null;
    content = (
      <ListView
        key={projectId ?? route.kind}
        projectId={projectId}
        activeOnly={route.kind === "active"}
        onNewTask={openNewTask}
      />
    );
  }

  return (
    <div className="relative flex h-full min-h-0 bg-background text-foreground">
      <main className="@container flex min-w-0 flex-1 flex-col">
        <TasksTopbar
          route={route}
          projects={projects}
          onNavigate={navigation.go}
          onNewTask={openNewTask}
          onBack={backFromTask}
        />
        <div className="min-h-0 flex-1 overflow-auto">{content}</div>
      </main>
      {newTaskOpen ? (
        <NewTaskDialog
          onClose={() => setNewTaskOpen(false)}
          projects={projects ?? []}
          projectId={route.kind === "project" ? route.projectId : null}
        />
      ) : null}
      {newProjectOpen ? (
        <NewProjectDialog onClose={() => setNewProjectOpen(false)} />
      ) : null}
    </div>
  );
}
