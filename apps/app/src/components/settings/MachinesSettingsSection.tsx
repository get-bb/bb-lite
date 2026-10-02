import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Host, HostPlatform, PermissionMode } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  ResourceOverflowMenu,
  ResourceRowDetailChevron,
  targetsResourceAction,
} from "@bb/shared-ui/resource-list";
import { AddMachineDialog } from "@/components/dialogs/AddMachineDialog";
import { machineActions } from "@/components/machines/machine-actions";
import { MachineReconnectDialog } from "@/components/machines/MachineReconnectDialog";
import { MachineRemoveDialog } from "@/components/machines/MachineRemoveDialog";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import {
  machineStatusLabel,
  machineStatusTone,
} from "@/components/machines/machine-status";
import { MachineRenameDialog } from "@/components/settings/MachineRenameDialog";
import { MachineLabel } from "@/components/machines/MachineLabel";
import {
  SettingsBadge,
  SettingsRow,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section";
import { useRenameHost } from "@/hooks/mutations/host-mutations";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useLocalHostId } from "@/hooks/useOpenTargets";
import { getSettingsMachineRoutePath } from "@/lib/route-paths";
import { PERMISSION_MODE_OPTIONS } from "@/lib/permission-mode-options";
import { getMutationErrorMessage } from "@/lib/mutation-errors";

const PERMISSION_MODE_PRESENTATION: Record<
  PermissionMode,
  (typeof PERMISSION_MODE_OPTIONS)[number]
> = Object.fromEntries(
  PERMISSION_MODE_OPTIONS.map((option) => [option.value, option]),
) as Record<PermissionMode, (typeof PERMISSION_MODE_OPTIONS)[number]>;

const PLATFORM_LABELS: Record<HostPlatform, string | null> = {
  darwin: "macOS",
  linux: "Linux",
  wsl: "WSL",
  unknown: null,
};

interface MachineRowProps {
  host: Host;
  isPrimary: boolean;
  isThisMachine: boolean;
  showServerBadge: boolean;
  platformLabel: string | null;
  projectCount: number;
  now: number;
  onRename: () => void;
  onRemove: () => void;
  onReconnect: () => void;
}

export function MachineRowContent({
  host,
  isPrimary,
  isThisMachine,
  showServerBadge,
  platformLabel,
  projectCount,
  now,
  onRename,
  onRemove,
  onReconnect,
}: MachineRowProps) {
  const navigate = useNavigate();
  const detailPath = getSettingsMachineRoutePath(host.id);
  const permission = PERMISSION_MODE_PRESENTATION[host.maxPermissionMode];
  const projectLabel = `${projectCount} ${projectCount === 1 ? "project" : "projects"}`;
  const connectionLabel = machineStatusLabel({ host, now });

  return (
    <SettingsRow>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div
          data-machine-row
          className="group group/machine -mx-2 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-2 transition-colors hover:bg-state-hover focus-within:bg-state-hover"
          onClick={(event) => {
            if (targetsResourceAction(event)) return;
            navigate(detailPath);
          }}
        >
          <Link
            to={getSettingsMachineRoutePath(host.id)}
            aria-label={`Open ${host.name}`}
            className="flex min-w-0 flex-1 items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <MachineLabel
                  host={host}
                  nameClassName="text-sm font-medium text-foreground"
                />
                {isThisMachine ? (
                  <SettingsBadge>this machine</SettingsBadge>
                ) : null}
                {showServerBadge ? <SettingsBadge>server</SettingsBadge> : null}
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-subtle-foreground/75">
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <MachineStatusDot tone={machineStatusTone(host)} />
                  <span className="min-w-0 truncate">{connectionLabel}</span>
                </span>
                {platformLabel === null ? null : (
                  <span className="truncate">{platformLabel}</span>
                )}
                <span className="shrink-0">{projectLabel}</span>
                <span
                  className={cn(
                    "shrink-0",
                    permission.tone === "warning" && "text-warning-text",
                  )}
                >
                  {permission.label}
                </span>
              </div>
            </div>
          </Link>
          <div className="flex shrink-0 items-center gap-1">
            <ResourceOverflowMenu
              label={`${host.name} actions`}
              items={machineActions({
                host,
                isPrimary,
                onRename,
                onReconnect,
                onRemove,
              })}
            />
            <ResourceRowDetailChevron />
          </div>
        </div>
      </div>
    </SettingsRow>
  );
}

export function MachinesSettingsSection() {
  const systemConfig = useSystemConfig();
  const hostsQuery = useHosts({ includeCreating: true });
  const localHostId = useLocalHostId();
  const sidebarNavigationQuery = useSidebarNavigation();
  const renameHost = useRenameHost();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Host | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Host | null>(null);
  const [reconnectTargetId, setReconnectTargetId] = useState<string | null>(
    null,
  );

  const hosts = hostsQuery.data;
  const serverPrimaryHostId = systemConfig.data?.primaryHostId ?? null;
  const projects = sidebarNavigationQuery.data?.projects;
  const projectCountByHostId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of projects ?? []) {
      const hostIds = new Set(project.sources.map((source) => source.hostId));
      for (const hostId of hostIds) {
        counts.set(hostId, (counts.get(hostId) ?? 0) + 1);
      }
    }
    return counts;
  }, [projects]);

  const now = Date.now();
  const primaryHostPlatform = systemConfig.data?.primaryHostPlatform ?? null;
  const persistentHosts = hosts?.filter((host) => host.type === "persistent");
  const visibleHosts = persistentHosts ?? [];
  const showThisMachineBadge = (persistentHosts?.length ?? 0) > 1;
  const hasMachineRows =
    persistentHosts !== undefined && persistentHosts.length > 0;
  const renderMachineRows = (rows: readonly Host[]) => (
    <SettingsRowList>
      {rows.map((host) => (
        <MachineRowContent
          key={host.id}
          host={host}
          isPrimary={host.id === serverPrimaryHostId}
          isThisMachine={showThisMachineBadge && host.id === localHostId}
          showServerBadge={host.id === serverPrimaryHostId}
          platformLabel={
            host.id === serverPrimaryHostId && primaryHostPlatform !== null
              ? PLATFORM_LABELS[primaryHostPlatform]
              : null
          }
          projectCount={projectCountByHostId.get(host.id) ?? 0}
          now={now}
          onRename={() => {
            renameHost.reset();
            setRenameTarget(host);
          }}
          onRemove={() => {
            setRemoveTarget(host);
          }}
          onReconnect={() => {
            setReconnectTargetId(host.id);
          }}
        />
      ))}
    </SettingsRowList>
  );

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
            hasMachineRows && "py-2",
          )}
        >
          {hosts === undefined ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : visibleHosts.length === 0 ? (
            <p className="text-sm text-subtle-foreground">No machines yet.</p>
          ) : (
            renderMachineRows(visibleHosts)
          )}
        </div>
      </SettingsSection>

      <AddMachineDialog open={addDialogOpen} onOpenChange={setAddDialogOpen} />

      <MachineRenameDialog
        target={renameTarget}
        pending={renameHost.isPending}
        errorMessage={
          renameHost.isError
            ? getMutationErrorMessage({
                error: renameHost.error,
                fallbackMessage: "Couldn't rename the machine.",
              })
            : null
        }
        onOpenChange={(open) => {
          if (!open && !renameHost.isPending) setRenameTarget(null);
        }}
        onRename={(host, name) =>
          renameHost.mutate(
            { hostId: host.id, name },
            { onSuccess: () => setRenameTarget(null) },
          )
        }
      />

      <MachineReconnectDialog
        target={hosts?.find((host) => host.id === reconnectTargetId) ?? null}
        onOpenChange={(open) => {
          if (!open) setReconnectTargetId(null);
        }}
      />

      <MachineRemoveDialog
        target={removeTarget}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      />
    </>
  );
}
