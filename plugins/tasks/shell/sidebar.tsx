import { useState, type ReactNode } from "react";
import type { PluginNavPanelProps } from "@bb/plugin/app";
import { useOverview } from "./data.js";
import { parseTasksRoute, useTasksNavigation } from "./routes.js";
import { NewProjectDialog } from "../views/manage/new-project-dialog.js";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

function SidebarRow({
  active,
  onClick,
  children,
  title,
}: {
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:h-9",
        "cursor-pointer",
        active
          ? "bg-sidebar-accent font-medium text-foreground"
          : "text-muted-foreground",
        !active && "hover:bg-state-hover hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function WorkingDot() {
  return (
    <span
      aria-hidden
      className="size-1.5 shrink-0 animate-pulse rounded-full bg-success"
    />
  );
}

function RowCount({ value }: { value: number }) {
  return (
    <span className="ml-auto text-xs tabular-nums text-muted-foreground">
      {value}
    </span>
  );
}

export function TasksNavigationPanel({ subPath }: PluginNavPanelProps) {
  const route = parseTasksRoute(subPath);
  const navigation = useTasksNavigation();
  const overview = useOverview();
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const { projects = [], summaries, activeTaskCount } = overview.data ?? {};
  const totalTasks = (summaries ?? []).reduce(
    (sum, entry) => sum + entry.taskCount,
    0,
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-2">
        <div className="space-y-px">
          <SidebarRow
            active={route.kind === "all"}
            onClick={() => navigation.go({ kind: "all" })}
          >
            <Icon name="ListView" className="size-3.5 shrink-0" />
            <span className="flex-1">All tasks</span>
            {summaries ? <RowCount value={totalTasks} /> : null}
          </SidebarRow>
          <SidebarRow
            active={route.kind === "active"}
            onClick={() => navigation.go({ kind: "active" })}
          >
            <Icon name="Zap" className="size-3.5 shrink-0" />
            <span className="flex-1">Active</span>
            {activeTaskCount ? <WorkingDot /> : null}
            {activeTaskCount === undefined ? null : (
              <RowCount value={activeTaskCount} />
            )}
          </SidebarRow>
        </div>
        {projects.length > 0 ? (
          <>
            <div className="mt-3.5 flex items-center gap-1 px-2 pb-1 text-xs font-semibold text-muted-foreground">
              Projects
            </div>
            <div className="space-y-px">
              {projects.map((project) => {
                const summary = summaries?.find(
                  (entry) => entry.projectId === project.id,
                );
                return (
                  <SidebarRow
                    key={project.id}
                    title={project.name}
                    active={
                      route.kind === "project" && route.projectId === project.id
                    }
                    onClick={() =>
                      navigation.go({ kind: "project", projectId: project.id })
                    }
                  >
                    <span
                      aria-hidden
                      className="size-3 shrink-0 rounded-sm"
                      style={{ backgroundColor: project.color }}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {project.name}
                    </span>
                    {summary?.activeAgentCount ? <WorkingDot /> : null}
                    {summary ? <RowCount value={summary.taskCount} /> : null}
                  </SidebarRow>
                );
              })}
            </div>
            <div className="mt-1.5">
              <SidebarRow
                onClick={() => setNewProjectOpen(true)}
                title="New project"
              >
                <Icon name="Plus" className="size-3.5 shrink-0" />
                <span className="flex-1">New project</span>
              </SidebarRow>
            </div>
          </>
        ) : null}
      </nav>
      <div className="shrink-0 border-t border-border-hairline px-2 py-1.5">
        <SidebarRow
          active={route.kind === "manage"}
          onClick={() => navigation.go({ kind: "manage" })}
        >
          <Icon name="Settings" className="size-3.5 shrink-0" />
          <span className="flex-1">Manage</span>
        </SidebarRow>
      </div>
      {newProjectOpen ? (
        <NewProjectDialog onClose={() => setNewProjectOpen(false)} />
      ) : null}
    </div>
  );
}

export function TasksSidebarAccessory() {
  const count = useOverview().data?.openTaskCount;
  return count ? (
    <span className="text-muted-foreground tabular-nums">{count}</span>
  ) : null;
}
