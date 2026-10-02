import { useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { findLocalPathProjectSourceForHost } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { Pill } from "@bb/shared-ui/pill";
import { ResourceOverflowMenu } from "@bb/shared-ui/resource-list";
import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "@bb/shared-ui/confirm-delete-dialog";
import {
  ProjectMachineSetupDialog,
  type ProjectMachineSetupDialogTarget,
} from "@/components/dialogs/ProjectMachineSetupDialog";
import { ProjectPathDialog } from "@/components/dialogs/ProjectPathDialog";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import { useProjectActions } from "@/components/project/ProjectActionsProvider";
import { ScopedMachineEnvironmentSettings } from "@/components/settings/MachineEnvironmentSettings";
import {
  SettingsBackLink,
  SettingsDetailShell,
} from "@/components/settings/SettingsDropdown";
import {
  formatGitRemote,
  pluralize,
} from "@/components/settings/ProjectsSettingsSection";
import { PageShell } from "@/components/ui/page-shell.js";
import {
  SettingsBadge,
  SettingsDetailRow,
  SettingsRow,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section";
import {
  useAddLocalProjectSource,
  useDeleteLocalProjectSource,
  useUpdateLocalProjectSource,
} from "@/hooks/mutations/project-mutations";
import {
  isHostPathMissing,
  useHostPathExistence,
} from "@/hooks/queries/host-queries";
import { selectHosts, useHosts } from "@/hooks/queries/host-queries";
import { useProjectDefaultExecutionOptions } from "@/hooks/queries/project-default-execution-options-query";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useLocalPathPicker } from "@/hooks/useLocalPathPicker";
import { PERMISSION_MODE_OPTIONS } from "@/lib/permission-mode-options";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  getSettingsMachineRoutePath,
  getSettingsRoutePath,
} from "@/lib/route-paths";

export function ProjectDetailSettingsView() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigation = useSidebarNavigation();
  const hostsQuery = useHosts();
  const primaryHostId = useSystemConfig().data?.primaryHostId ?? null;
  const defaultsQuery = useProjectDefaultExecutionOptions({ projectId });
  const { requestRename, requestDelete } = useProjectActions();
  const addLocalSource = useAddLocalProjectSource();
  const updateLocalSource = useUpdateLocalProjectSource();
  const deleteSource = useDeleteLocalProjectSource();
  const [sourceDeleteTarget, setSourceDeleteTarget] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [machineSetupTarget, setMachineSetupTarget] =
    useState<ProjectMachineSetupDialogTarget | null>(null);
  const [existed, setExisted] = useState(false);

  const projects = navigation.data?.projects;
  const project = projects?.find((entry) => entry.id === projectId) ?? null;
  const sources = project?.sources ?? [];
  const hosts = selectHosts(hostsQuery.data, "persistent");
  const pathPending = addLocalSource.isPending || updateLocalSource.isPending;
  const picker = useLocalPathPicker({
    isPending: pathPending,
    submit: ({ path, hostId, target, closeDialog }) => {
      if (target.kind === "create") return;
      const source = sources.find((candidate) => candidate.hostId === hostId);
      const options = { onSuccess: closeDialog };
      if (target.kind === "add-source")
        addLocalSource.mutate(
          { projectId: target.projectId, path, hostId },
          options,
        );
      else if (source)
        updateLocalSource.mutate(
          { projectId: target.projectId, sourceId: source.id, path },
          options,
        );
    },
  });
  const pathExistence = useHostPathExistence(
    picker.hostId,
    sources
      .filter((source) => source.hostId === picker.hostId)
      .map((source) => source.path),
  );
  if (project !== null && !existed) setExisted(true);

  if (navigation.isError || hostsQuery.isError) {
    return (
      <SettingsDetailShell section="projects" label="Projects">
        <p className="text-sm text-destructive" role="alert">
          Couldn't load this project.
        </p>
      </SettingsDetailShell>
    );
  }
  if (projects === undefined || hostsQuery.data === undefined) {
    return (
      <SettingsDetailShell section="projects" label="Projects">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </SettingsDetailShell>
    );
  }
  if (project === null) {
    return existed ? (
      <Navigate to={getSettingsRoutePath("projects")} replace />
    ) : (
      <SettingsDetailShell section="projects" label="Projects">
        <p className="text-sm text-muted-foreground">
          This project no longer exists.
        </p>
      </SettingsDetailShell>
    );
  }

  const configuredCount = hosts.filter((host) =>
    sources.some((source) => source.hostId === host.id),
  ).length;
  const defaults = defaultsQuery.data ?? null;
  const pending = pathPending || deleteSource.isPending;
  const target = { projectId: project.id, projectName: project.name };

  return (
    <PageShell contentClassName="pt-4 md:pt-5">
      <div className="mx-auto w-full max-w-3xl space-y-6 pb-10">
        <div className="space-y-3">
          <SettingsBackLink section="projects" label="Projects" />
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <Icon
                  name="FolderGit"
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <h1 className="min-w-0 truncate text-sm font-semibold text-foreground">
                  {project.name}
                </h1>
                {configuredCount === 0 ? (
                  <SettingsBadge>needs setup</SettingsBadge>
                ) : null}
              </div>
              <p className="mt-1 min-w-0 truncate text-xs text-subtle-foreground/75">
                {project.gitRemoteUrl === null
                  ? "No git remote"
                  : formatGitRemote(project.gitRemoteUrl)}
                {" · "}
                {hosts.length > 1
                  ? `${configuredCount} of ${pluralize(hosts.length, "machine")}`
                  : pluralize(configuredCount, "machine")}
                {" · "}
                {pluralize(project.threads.length, "thread")}
              </p>
            </div>
            <ResourceOverflowMenu
              label={`${project.name} actions`}
              items={[
                {
                  label: "Rename",
                  icon: "Edit",
                  onSelect: () => requestRename(project),
                },
              ]}
            />
          </div>
        </div>

        <SettingsSection
          title="Checkouts"
          description="Where this project lives on each machine. A machine needs a checkout before it can run threads for this project."
        >
          {hosts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No machines are paired yet.
            </p>
          ) : (
            <SettingsRowList>
              {hosts.map((host) => {
                const source =
                  findLocalPathProjectSourceForHost(sources, host.id) ?? null;
                const isPickerHost = host.id === picker.hostId;
                const connected = host.status === "connected";
                return (
                  <SettingsRow key={host.id} className="items-start">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Icon
                          name="Laptop"
                          className={cn(
                            "size-4 shrink-0 text-muted-foreground",
                            !connected && "opacity-60",
                          )}
                        />
                        <MachineStatusDot connected={connected} />
                        <Link
                          to={getSettingsMachineRoutePath(host.id)}
                          className="min-w-0 truncate text-sm font-medium text-foreground hover:underline"
                        >
                          {host.name}
                        </Link>
                        {hosts.length > 1 && host.id === primaryHostId ? (
                          <SettingsBadge>primary</SettingsBadge>
                        ) : null}
                        {isPickerHost &&
                        isHostPathMissing(pathExistence, source?.path) ? (
                          <Pill variant="destructive">Path not found</Pill>
                        ) : null}
                      </div>
                      <div className="min-w-0 truncate font-mono text-xs text-subtle-foreground/75">
                        {source === null ? (
                          <span className="font-sans italic">
                            Not set up on this machine
                          </span>
                        ) : (
                          source.path
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {source === null ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={pending || !connected}
                          onClick={() =>
                            isPickerHost
                              ? picker.openPicker({
                                  kind: "add-source",
                                  ...target,
                                })
                              : setMachineSetupTarget({
                                  ...target,
                                  gitRemoteUrl: project.gitRemoteUrl,
                                  hostId: host.id,
                                  hostName: host.name,
                                })
                          }
                        >
                          {connected ? "Set up" : "Offline"}
                        </Button>
                      ) : (
                        <ResourceOverflowMenu
                          label={`${host.name} checkout actions`}
                          items={[
                            {
                              label: "Change folder",
                              icon: "Folder",
                              disabled: !isPickerHost || pending,
                              disabledReason: isPickerHost
                                ? undefined
                                : "Folders on other machines are changed from that machine.",
                              onSelect: () =>
                                picker.openPicker({
                                  kind: "update",
                                  ...target,
                                  currentPath: source.path,
                                }),
                            },
                            {
                              label: "Remove checkout",
                              icon: "Trash2",
                              tone: "destructive",
                              disabled: sources.length <= 1 || pending,
                              disabledReason:
                                sources.length <= 1
                                  ? "A project needs at least one checkout."
                                  : undefined,
                              onSelect: () =>
                                setSourceDeleteTarget({
                                  id: source.id,
                                  label: `${host.name} · ${source.path}`,
                                }),
                            },
                          ]}
                        />
                      )}
                    </div>
                  </SettingsRow>
                );
              })}
            </SettingsRowList>
          )}
        </SettingsSection>

        <SettingsSection
          title="Thread defaults"
          description="What new threads in this project start with. bb remembers the last options you used here."
        >
          {defaultsQuery.isError ? (
            <p className="text-sm text-destructive" role="alert">
              Couldn't load thread defaults.
            </p>
          ) : defaultsQuery.isPending ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : defaults === null ? (
            <p className="text-sm text-muted-foreground">
              No threads have run here yet. The first thread's options become
              the defaults.
            </p>
          ) : (
            <SettingsRowList>
              <SettingsDetailRow label="Provider">
                <span>{defaults.providerId}</span>
              </SettingsDetailRow>
              <SettingsDetailRow label="Model">
                <span className="font-mono text-xs">{defaults.model}</span>
              </SettingsDetailRow>
              <SettingsDetailRow label="Permission mode">
                <span>
                  {PERMISSION_MODE_OPTIONS.find(
                    (option) => option.value === defaults.permissionMode,
                  )?.label ?? defaults.permissionMode}
                </span>
              </SettingsDetailRow>
              <SettingsDetailRow label="Reasoning">
                <span>{defaults.reasoningLevel}</span>
              </SettingsDetailRow>
            </SettingsRowList>
          )}
        </SettingsSection>

        <SettingsSection title="Project information">
          <SettingsRowList>
            <SettingsDetailRow label="Git remote">
              {project.gitRemoteUrl === null ? (
                <span>None detected</span>
              ) : (
                <span className="min-w-0 truncate font-mono text-xs">
                  {project.gitRemoteUrl}
                </span>
              )}
            </SettingsDetailRow>
            <SettingsDetailRow label="Project ID">
              <span className="font-mono text-xs">{project.id}</span>
            </SettingsDetailRow>
            <SettingsDetailRow label="Created">
              <span>
                {formatRelativeTime({
                  timestamp: project.createdAt,
                  now: Date.now(),
                })}
              </span>
            </SettingsDetailRow>
          </SettingsRowList>
        </SettingsSection>

        <ScopedMachineEnvironmentSettings
          key={project.id}
          projectId={project.id}
        />

        <SettingsSection
          title="Danger zone"
          description={`Deleting ${project.name} removes the project and every thread in it, including archived ones. Checkouts stay on disk.`}
        >
          <SettingsRowList>
            <SettingsRow>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => requestDelete(project)}
              >
                Delete project
              </Button>
            </SettingsRow>
          </SettingsRowList>
        </SettingsSection>
      </div>

      <ProjectPathDialog
        target={picker.projectPathDialog.target}
        pending={pathPending}
        hostId={picker.hostId}
        hostName={picker.hostName}
        onOpenChange={picker.projectPathDialog.onOpenChange}
        onSubmit={picker.submitProjectPath}
      />
      <ProjectMachineSetupDialog
        target={machineSetupTarget}
        onOpenChange={(open) => {
          if (!open) setMachineSetupTarget(null);
        }}
        onComplete={() => setMachineSetupTarget(null)}
      />
      <ConfirmDeleteDialog
        open={sourceDeleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setSourceDeleteTarget(null);
        }}
      >
        {sourceDeleteTarget ? (
          <ConfirmDeleteDialogContent
            title="Remove source?"
            description={`Remove "${sourceDeleteTarget.label}" from this project? This cannot be undone.`}
            confirmLabel="Remove source"
            pending={deleteSource.isPending}
            onConfirm={() =>
              deleteSource.mutate(
                { projectId: project.id, sourceId: sourceDeleteTarget.id },
                { onSuccess: () => setSourceDeleteTarget(null) },
              )
            }
          />
        ) : null}
      </ConfirmDeleteDialog>
    </PageShell>
  );
}
