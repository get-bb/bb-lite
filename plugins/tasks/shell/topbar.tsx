import type { Project } from "../shared/contract.js";
import type { TasksRoute } from "./routes.js";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";

function ProjectDot({ project }: { project: Project }) {
  return (
    <span
      aria-hidden
      className="size-3 shrink-0 rounded-sm"
      style={{ backgroundColor: project.color }}
    />
  );
}

function Titled({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="whitespace-nowrap font-semibold">{title}</span>
      <span className="hidden text-xs font-normal text-muted-foreground @md:inline">
        {subtitle}
      </span>
    </span>
  );
}

export function TasksTopbar({
  route,
  projects,
  onNavigate,
  onNewTask,
  onBack,
}: {
  route: TasksRoute;
  projects: Project[] | undefined;
  onNavigate: (route: TasksRoute) => void;
  onNewTask: () => void;
  onBack: () => void;
}) {
  const prefix = route.kind === "task" ? route.taskKey.split("-", 1)[0] : "";
  const project = (projects ?? []).find((candidate) =>
    route.kind === "project"
      ? candidate.id === route.projectId
      : candidate.prefix === prefix?.toUpperCase(),
  );

  const breadcrumb = (() => {
    switch (route.kind) {
      case "all":
        return (
          <span className="whitespace-nowrap font-semibold">All tasks</span>
        );
      case "active":
        return <Titled title="Active" subtitle="agents working now" />;
      case "manage":
        return <Titled title="Manage" subtitle="labels" />;
      case "project":
        return (
          <span className="flex min-w-0 items-center gap-2">
            {project ? <ProjectDot project={project} /> : null}
            <span className="truncate font-semibold">
              {project?.name ?? "Project"}
            </span>
          </span>
        );
      case "task":
        return (
          <span className="flex min-w-0 items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              className="size-6 shrink-0"
              aria-label="Back (Esc)"
              onClick={onBack}
            >
              <Icon name="ChevronLeft" className="size-4" />
            </Button>
            {project ? (
              <>
                <button
                  type="button"
                  className="hidden min-w-0 items-center gap-2 text-muted-foreground hover:text-foreground @md:flex"
                  onClick={() =>
                    onNavigate({ kind: "project", projectId: project.id })
                  }
                >
                  <ProjectDot project={project} />
                  <span className="truncate font-medium">{project.name}</span>
                </button>
                <Icon
                  name="ChevronRight"
                  className="hidden size-3 shrink-0 text-muted-foreground @md:block"
                />
              </>
            ) : null}
            <span className="min-w-0 truncate font-medium text-muted-foreground">
              {route.taskKey}
            </span>
          </span>
        );
    }
  })();

  return (
    <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border-hairline bg-background px-3.5 text-sm">
      <div className="min-w-0 flex-1 overflow-hidden">{breadcrumb}</div>
      {route.kind !== "task" && route.kind !== "manage" ? (
        <Button
          size="sm"
          className="h-7 gap-1.5"
          aria-label="New task"
          onClick={onNewTask}
        >
          <Icon name="Plus" className="size-3.5" />
          <span className="hidden @lg:inline">New task</span>
        </Button>
      ) : null}
    </header>
  );
}
