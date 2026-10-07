import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { HostPlatform } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  ResourceOverflowMenu,
  ResourceRowDetailChevron,
  targetsResourceAction,
} from "@bb/shared-ui/resource-list";
import { AddMachineDialog } from "@/components/dialogs/AddMachineDialog";
import { MachineLabel } from "@/components/machines/MachineLabel";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import {
  machineStatusLabel,
  useMachineDialogs,
} from "@/components/machines/machine-dialogs";
import {
  SettingsBadge,
  SettingsRow,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import {
  useCurrentUser,
  useIsMultiUser,
  useUserDirectory,
} from "@/hooks/queries/user-queries";
import { useLocalHostId } from "@/hooks/useOpenTargets";
import {
  canManageMachine,
  isMachineOwner,
  machineOwnerName,
} from "@/lib/machine-access";
import { PERMISSION_MODE_OPTIONS } from "@/lib/permission-mode-options";
import { pluralize } from "./ProjectsSettingsSection";
import { getSettingsMachineRoutePath } from "@/lib/route-paths";

export const PLATFORM_LABELS: Record<HostPlatform, string | null> = {
  darwin: "macOS",
  linux: "Linux",
  wsl: "WSL",
  unknown: null,
};

export function MachinesSettingsSection() {
  const navigate = useNavigate();
  const systemConfig = useSystemConfig().data;
  const hosts = useHosts({ includeCreating: true }).data;
  const localHostId = useLocalHostId();
  const currentUser = useCurrentUser();
  const users = useUserDirectory();
  const isMultiUser = useIsMultiUser();
  const projects = useSidebarNavigation().data?.projects ?? [];
  const dialogs = useMachineDialogs(hosts);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const primaryHostId = systemConfig?.primaryHostId ?? null;
  const machines = hosts?.filter((host) => host.type === "persistent") ?? [];
  return (
    <>
      <SettingsSection
        title="Machines"
        bodyClassName="space-y-3 border-0 bg-transparent p-0"
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAddDialogOpen(true)}
          >
            <Icon name="Plus" className="size-3.5" />
            Add a machine
          </Button>
        }
      >
        <div
          role="note"
          aria-label="About the bb server"
          className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3"
        >
          <Icon
            name="Info"
            className="mt-0.5 size-4 shrink-0 text-subtle-foreground"
            aria-hidden
          />
          <div className="min-w-0 space-y-1 text-xs leading-relaxed text-subtle-foreground">
            <p className="font-medium text-foreground">How machines connect</p>
            <p>
              All your machines connect to one central bb server, where your
              threads and settings are stored. Choose a machine that can stay
              awake and online to run the server.
            </p>
          </div>
        </div>
        <div
          className={cn(
            "rounded-lg border border-border bg-card px-4 py-3.5",
            machines.length > 0 && "py-2",
          )}
        >
          {hosts === undefined ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : machines.length === 0 ? (
            <p className="text-sm text-subtle-foreground">No machines yet.</p>
          ) : (
            <SettingsRowList>
              {machines.map((host) => {
                const isPrimary = host.id === primaryHostId;
                const platform =
                  isPrimary && systemConfig?.primaryHostPlatform
                    ? PLATFORM_LABELS[systemConfig.primaryHostPlatform]
                    : null;
                const projectCount = projects.filter((project) =>
                  project.sources.some((source) => source.hostId === host.id),
                ).length;
                const permission = PERMISSION_MODE_OPTIONS.find(
                  (option) => option.value === host.maxPermissionMode,
                );
                const detailPath = getSettingsMachineRoutePath(host.id);
                const ownerLabel = !isMultiUser
                  ? null
                  : isMachineOwner(host, currentUser)
                    ? "You"
                    : machineOwnerName(host, users);
                return (
                  <SettingsRow key={host.id}>
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <div
                        data-machine-row
                        className="group group/machine -mx-2 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-2 transition-colors hover:bg-state-hover focus-within:bg-state-hover"
                        onClick={(event) => {
                          if (!targetsResourceAction(event))
                            navigate(detailPath);
                        }}
                      >
                        <Link
                          to={detailPath}
                          aria-label={`Open ${host.name}`}
                          className="flex min-w-0 flex-1 items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <MachineLabel
                                host={host}
                                nameClassName="text-sm font-medium text-foreground"
                              />
                              {machines.length > 1 &&
                              host.id === localHostId ? (
                                <SettingsBadge>this machine</SettingsBadge>
                              ) : null}
                              {isPrimary ? (
                                <SettingsBadge>server</SettingsBadge>
                              ) : null}
                            </div>
                            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-subtle-foreground/75">
                              <span className="inline-flex min-w-0 items-center gap-1.5">
                                <MachineStatusDot
                                  connected={host.status === "connected"}
                                />
                                <span className="min-w-0 truncate">
                                  {machineStatusLabel(host)}
                                </span>
                              </span>
                              {platform === null ? null : (
                                <span className="truncate">{platform}</span>
                              )}
                              <span className="shrink-0">
                                {pluralize(projectCount, "project")}
                              </span>
                              <span
                                className={cn(
                                  "shrink-0",
                                  permission?.tone === "warning" &&
                                    "text-warning-text",
                                )}
                              >
                                {permission?.label}
                              </span>
                              {isMultiUser ? (
                                <span className="inline-flex shrink-0 items-center gap-1">
                                  {host.sharing === "shared" ? null : (
                                    <Icon
                                      name="Lock"
                                      className="size-3"
                                      aria-hidden
                                    />
                                  )}
                                  {host.sharing === "shared"
                                    ? "Shared"
                                    : "Private"}
                                </span>
                              ) : null}
                              {ownerLabel === null ? null : (
                                <span
                                  title={`Owner: ${ownerLabel}`}
                                  className="inline-flex min-w-0 items-center gap-1"
                                >
                                  <Icon
                                    name="UserRound"
                                    className="size-3 shrink-0"
                                    aria-hidden
                                  />
                                  <span className="sr-only">Owner:</span>
                                  <span className="min-w-0 truncate">
                                    {ownerLabel}
                                  </span>
                                </span>
                              )}
                            </div>
                          </div>
                        </Link>
                        <div className="flex shrink-0 items-center gap-1">
                          {canManageMachine(host, currentUser) ? (
                            <ResourceOverflowMenu
                              label={`${host.name} actions`}
                              items={dialogs.menuItems(host, isPrimary, true)}
                            />
                          ) : null}
                          <ResourceRowDetailChevron />
                        </div>
                      </div>
                    </div>
                  </SettingsRow>
                );
              })}
            </SettingsRowList>
          )}
        </div>
      </SettingsSection>
      <AddMachineDialog open={addDialogOpen} onOpenChange={setAddDialogOpen} />
      {dialogs.dialogs}
    </>
  );
}
