import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { arrayMove } from "@dnd-kit/sortable";
import type { Host } from "@bb/domain";
import type { ProjectWithThreadsResponse } from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import "@bb/shared-ui/icon-extended";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  ResourceOverflowMenu,
  ResourceRowDetailChevron,
} from "@bb/shared-ui/resource-list";
import { useProjectActions } from "@/components/project/ProjectActionsProvider";
import {
  SettingsBadge,
  SettingsRow,
  SettingsSection,
} from "@/components/ui/settings-section";
import { useReorderProject } from "@/hooks/mutations/project-mutations";
import { selectHosts, useHosts } from "@/hooks/queries/host-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useQuickCreateProjectController } from "@/hooks/useQuickCreateProject";
import { getSettingsProjectRoutePath } from "@/lib/route-paths";
import {
  SortableSettingsRowList,
  useSortableSettingsRow,
} from "./sortable-settings-rows";

export function formatGitRemote(url: string): string {
  const sshMatch = /^[^@]+@([^:]+):(.+?)(?:\.git)?$/.exec(url);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname.replace(/\.git$/, "")}`;
  } catch {
    return url;
  }
}

export function pluralize(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function SortableProjectRow({
  project,
  hosts,
  dragDisabled,
}: {
  project: ProjectWithThreadsResponse;
  hosts: readonly Host[];
  dragDisabled: boolean;
}) {
  const { requestRename, requestDelete } = useProjectActions();
  const { setNodeRef, style, isDragging, handle } = useSortableSettingsRow({
    id: project.id,
    disabled: dragDisabled,
    label: project.name,
  });
  const configured = hosts.filter((host) =>
    project.sources.some((source) => source.hostId === host.id),
  );
  const needsSetup = configured.length === 0;
  const allOffline =
    !needsSetup && configured.every((host) => host.status !== "connected");
  return (
    <SettingsRow
      ref={setNodeRef}
      style={style}
      className={cn(
        "items-start",
        isDragging && "relative z-10 rounded-md bg-card opacity-90 shadow-lift",
      )}
    >
      {handle}
      <div
        data-project-row
        className="group -mx-2 flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-state-hover focus-within:bg-state-hover"
      >
        <Link
          to={getSettingsProjectRoutePath(project.id)}
          aria-label={`Open ${project.name} settings`}
          className="min-w-0 flex-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <Icon
                name="FolderGit"
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 truncate text-sm font-medium text-foreground">
                {project.name}
              </span>
              {needsSetup ? <SettingsBadge>needs setup</SettingsBadge> : null}
              {allOffline ? <SettingsBadge>offline</SettingsBadge> : null}
            </div>
            <div className="min-w-0 space-y-0.5 text-xs text-subtle-foreground/75">
              {project.gitRemoteUrl === null ? (
                <div className="italic">No git remote</div>
              ) : (
                <div className="truncate">
                  {formatGitRemote(project.gitRemoteUrl)}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                <span
                  className={cn("shrink-0", needsSetup && "text-warning-text")}
                >
                  {needsSetup
                    ? "Not set up on any machine"
                    : hosts.length <= 1
                      ? "1 machine"
                      : `${configured.length} of ${hosts.length} machines`}
                </span>
                <span className="shrink-0">
                  {pluralize(project.threads.length, "thread")}
                </span>
              </div>
            </div>
          </div>
        </Link>
        <div className="flex shrink-0 items-center gap-1">
          <ResourceOverflowMenu
            label={`${project.name} actions`}
            items={[
              {
                label: "Rename",
                icon: "Edit",
                onSelect: () => requestRename(project),
              },
              {
                label: "Delete project",
                icon: "Trash2",
                tone: "destructive",
                onSelect: () => requestDelete(project),
              },
            ]}
          />
          <ResourceRowDetailChevron />
        </div>
      </div>
    </SettingsRow>
  );
}

export function ProjectsSettingsSection() {
  const navigation = useSidebarNavigation();
  const hosts = selectHosts(useHosts().data, "persistent");
  const reorderProject = useReorderProject();
  const quickCreateProject = useQuickCreateProjectController();
  const [order, setOrder] = useState<string[] | null>(null);
  const serverProjects = navigation.data?.projects;
  useEffect(() => setOrder(null), [serverProjects]);
  const projects =
    serverProjects === undefined || order === null
      ? serverProjects
      : [...serverProjects].sort(
          (left, right) => order.indexOf(left.id) - order.indexOf(right.id),
        );
  const ids = projects?.map((project) => project.id) ?? [];
  const dragDisabled = reorderProject.isPending || ids.length < 2;
  return (
    <SettingsSection
      title="Projects"
      description="Repositories bb can work in. Drag to change the order projects appear in the sidebar."
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={
            !quickCreateProject.isAvailable || quickCreateProject.isCreating
          }
          onClick={quickCreateProject.openCreateDialog}
        >
          <Icon name="Plus" className="size-3.5" />
          Add a project
        </Button>
      }
    >
      {navigation.isError ? (
        <p className="text-sm text-destructive" role="alert">
          Couldn't load projects.
        </p>
      ) : projects === undefined ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : projects.length === 0 ? (
        <p className="text-sm text-subtle-foreground">
          No projects yet. Add a project to start running threads in a
          repository.
        </p>
      ) : (
        <SortableSettingsRowList
          ids={ids}
          disabled={dragDisabled}
          onReorder={(activeId, overId) => {
            const from = ids.indexOf(activeId);
            const to = ids.indexOf(overId);
            if (from === -1 || to === -1 || from === to) return;
            const next = arrayMove(ids, from, to);
            setOrder(next);
            reorderProject.mutate(
              {
                id: activeId,
                previousProjectId: next[to - 1] ?? null,
                nextProjectId: next[to + 1] ?? null,
              },
              { onError: () => setOrder(null) },
            );
          }}
        >
          {projects.map((project) => (
            <SortableProjectRow
              key={project.id}
              project={project}
              hosts={hosts}
              dragDisabled={dragDisabled}
            />
          ))}
        </SortableSettingsRowList>
      )}
    </SettingsSection>
  );
}
