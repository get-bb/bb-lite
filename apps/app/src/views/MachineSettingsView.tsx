import { MachineLifecycleNoticeContent } from "@/components/machines/MachineLifecycleNotice";
import { useMemo, useState, type ComponentProps } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Host, PermissionMode } from "@bb/domain";
import type { HostPlatform } from "@bb/host-daemon-contract";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { ResourceOverflowMenu } from "@bb/shared-ui/resource-list";
import { machineActions } from "@/components/machines/machine-actions";
import {
  MachineRemoveDialog,
  SERVER_MACHINE_REMOVE_DISABLED_REASON,
  machineRemovalConsequences,
} from "@/components/machines/MachineRemoveDialog";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import { MachineReconnectDialog } from "@/components/machines/MachineReconnectDialog";
import {
  machineStatusLabel,
  machineStatusTone,
} from "@/components/machines/machine-status";
import { MachineLabel } from "@/components/machines/MachineLabel";
import { PageShell } from "@/components/ui/page-shell.js";
import {
  SettingsBadge,
  SettingsDetailRow,
  SettingsRow,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section";
import { MachineRenameDialog } from "@/components/settings/MachineRenameDialog";
import {
  useRenameHost,
  useUpdateHostPermissionCeiling,
} from "@/hooks/mutations/host-mutations";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { formatHostUpdateStatus } from "@/lib/host-update-status";
import {
  getMutationErrorMessage,
  showMutationErrorToast,
} from "@/lib/mutation-errors";
import { PERMISSION_MODE_OPTIONS } from "@/lib/permission-mode-options";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  getSettingsProjectRoutePath,
  getSettingsRoutePath,
} from "@/lib/route-paths";

const PERMISSION_LIMIT_DESCRIPTION =
  "Highest permission mode any thread on the selected machine may run with. Threads that ask for more resolve down to it, and a provider that supports nothing this low can't run here.";

const PLATFORM_LABELS: Record<HostPlatform, string | null> = {
  darwin: "macOS",
  linux: "Linux",
  wsl: "WSL",
  unknown: null,
};

interface MachineProject {
  id: string;
  name: string;
}

function headerMeta({
  host,
  platformLabel,
  now,
}: {
  host: Host;
  platformLabel: string | null;
  now: number;
}): string {
  const parts: string[] = [machineStatusLabel({ host, now })];
  if (platformLabel !== null) parts.push(platformLabel);
  parts.push(
    `paired ${formatRelativeTime({ timestamp: host.createdAt, now })}`,
  );
  return parts.join(" · ");
}

interface PermissionLimitCardProps {
  disabled: boolean;
  onSelect: (permissionMode: PermissionMode) => void;
  value: PermissionMode;
}

function PermissionLimitCards({
  disabled,
  onSelect,
  value,
}: PermissionLimitCardProps) {
  return (
    <div role="radiogroup" aria-label="Permission limit">
      <SettingsRowList>
        {PERMISSION_MODE_OPTIONS.map((option) => {
          const selected = option.value === value;
          return (
            <SettingsRow key={option.value} className="items-start">
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                onClick={() => {
                  if (!selected) onSelect(option.value);
                }}
                className={cn(
                  "flex w-full items-start gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  disabled && "opacity-70",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                    selected ? "border-foreground" : "border-input",
                  )}
                >
                  {selected ? (
                    <span className="size-2 rounded-full bg-foreground" />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-foreground">
                    {option.label}
                  </span>
                  {option.description ? (
                    <span className="mt-0.5 block text-xs leading-snug text-subtle-foreground/75">
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </button>
            </SettingsRow>
          );
        })}
      </SettingsRowList>
    </div>
  );
}

export function MachineSettingsHeader({
  host,
  platformLabel,
  now,
  isPrimary,
  isThisMachine,
  showServerBadge,
  lifecycleNotice,
  onRename,
  onReconnect,
}: {
  host: Host;
  platformLabel: string | null;
  now: number;
  isPrimary: boolean;
  isThisMachine: boolean;
  showServerBadge: boolean;
  lifecycleNotice: ComponentProps<
    typeof MachineLifecycleNoticeContent
  >["notice"];
  onRename: () => void;
  onReconnect: () => void;
}) {
  return (
    <div className="space-y-3">
      <Link
        to={getSettingsRoutePath("machines")}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <Icon name="ChevronLeft" className="size-3.5" />
        Machines
      </Link>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="min-w-0 text-sm font-semibold text-foreground">
              <MachineLabel host={host} />
            </h1>
            {isThisMachine ? <SettingsBadge>This machine</SettingsBadge> : null}
            {showServerBadge ? <SettingsBadge>Server</SettingsBadge> : null}
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <MachineStatusDot tone={machineStatusTone(host)} />
            <p className="min-w-0 text-xs text-subtle-foreground/75">
              {headerMeta({ host, platformLabel, now })}
            </p>
          </div>
          <MachineLifecycleNoticeContent notice={lifecycleNotice} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ResourceOverflowMenu
            label={`${host.name} actions`}
            items={machineActions({
              host,
              isPrimary,
              onRename,
              onReconnect,
            })}
          />
        </div>
      </div>
    </div>
  );
}

export function MachineSettingsView() {
  const { hostId } = useParams<{ hostId: string }>();
  const navigate = useNavigate();
  const hostsQuery = useHosts();
  const systemConfig = useSystemConfig();
  const { localDaemonHostId, platform: localDaemonPlatform } = useHostDaemon();
  const sidebarNavigationQuery = useSidebarNavigation();
  const renameHost = useRenameHost();
  const updatePermissionCeiling = useUpdateHostPermissionCeiling();
  const [renameOpen, setRenameOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [reconnectOpen, setReconnectOpen] = useState(false);

  const hosts = hostsQuery.data;
  const host = hosts?.find((candidate) => candidate.id === hostId) ?? null;
  const lifecycleMessage = host?.lifecycle.message ?? null;
  const lifecycleNotice = host === null ? null : { message: lifecycleMessage };
  const primaryHostId = systemConfig.data?.primaryHostId ?? null;
  const isPrimary = host !== null && host.id === primaryHostId;
  const showThisMachineBadge =
    (hosts?.filter((candidate) => candidate.type === "persistent").length ??
      0) > 1;
  const isThisMachine =
    showThisMachineBadge && host !== null && host.id === localDaemonHostId;

  const projects: MachineProject[] = useMemo(() => {
    const navigation = sidebarNavigationQuery.data?.projects ?? [];
    return navigation
      .filter((project) =>
        project.sources.some((source) => source.hostId === hostId),
      )
      .map((project) => ({ id: project.id, name: project.name }));
  }, [hostId, sidebarNavigationQuery.data]);

  const now = Date.now();
  const platformLabel =
    host !== null &&
    host.id === localDaemonHostId &&
    localDaemonPlatform !== null
      ? PLATFORM_LABELS[localDaemonPlatform]
      : isPrimary && systemConfig.data?.primaryHostPlatform
        ? PLATFORM_LABELS[systemConfig.data.primaryHostPlatform]
        : null;

  if (hosts === undefined) {
    return (
      <PageShell contentClassName="pt-4 md:pt-5">
        <div className="mx-auto w-full max-w-3xl">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      </PageShell>
    );
  }

  if (host === null) {
    return (
      <PageShell contentClassName="pt-4 md:pt-5">
        <div className="mx-auto w-full max-w-3xl space-y-3">
          <Link
            to={getSettingsRoutePath("machines")}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <Icon name="ChevronLeft" className="size-3.5" />
            Machines
          </Link>
          <p className="text-sm text-muted-foreground">
            Machine is no longer paired.
          </p>
        </div>
      </PageShell>
    );
  }

  const updateStatus = formatHostUpdateStatus(host);

  return (
    <PageShell contentClassName="pt-4 md:pt-5">
      <div className="mx-auto w-full max-w-3xl space-y-6 pb-10">
        <MachineSettingsHeader
          host={host}
          platformLabel={platformLabel}
          now={now}
          isPrimary={isPrimary}
          isThisMachine={isThisMachine}
          showServerBadge={isPrimary}
          lifecycleNotice={lifecycleNotice}
          onRename={() => {
            renameHost.reset();
            setRenameOpen(true);
          }}
          onReconnect={() => setReconnectOpen(true)}
        />

        <SettingsSection
          title="Permission limit"
          description={PERMISSION_LIMIT_DESCRIPTION}
        >
          <PermissionLimitCards
            value={host.maxPermissionMode}
            disabled={updatePermissionCeiling.isPending}
            onSelect={(maxPermissionMode) =>
              updatePermissionCeiling.mutate(
                { hostId: host.id, maxPermissionMode },
                {
                  onError: (error) => {
                    showMutationErrorToast({
                      error,
                      fallbackMessage: `Couldn't change the permission limit for ${host.name}.`,
                    });
                  },
                },
              )
            }
          />
        </SettingsSection>

        <SettingsSection title="Machine information">
          <SettingsRowList>
            <SettingsDetailRow label="Projects">
              {projects.length === 0 ? (
                <span>None</span>
              ) : (
                <span className="min-w-0 truncate">
                  {projects.map((project, index) => (
                    <span key={project.id}>
                      {index > 0 ? " · " : ""}
                      <Link
                        to={getSettingsProjectRoutePath(project.id)}
                        className="hover:text-foreground"
                      >
                        {project.name}
                      </Link>
                    </span>
                  ))}
                </span>
              )}
            </SettingsDetailRow>
            <SettingsDetailRow label="Updates">
              <span>{updateStatus ?? "Up to date"}</span>
            </SettingsDetailRow>
          </SettingsRowList>
        </SettingsSection>

        <SettingsSection
          title="Danger zone"
          description={
            isPrimary
              ? SERVER_MACHINE_REMOVE_DISABLED_REASON
              : `Revokes ${host.name}'s access to this server. ${machineRemovalConsequences(host)}`
          }
        >
          <SettingsRowList>
            <SettingsRow>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={isPrimary}
                onClick={() => setRemoveOpen(true)}
              >
                Remove machine
              </Button>
            </SettingsRow>
          </SettingsRowList>
        </SettingsSection>
      </div>

      <MachineRenameDialog
        target={renameOpen ? host : null}
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
          if (!open && !renameHost.isPending) setRenameOpen(false);
        }}
        onRename={(target, name) =>
          renameHost.mutate(
            { hostId: target.id, name },
            { onSuccess: () => setRenameOpen(false) },
          )
        }
      />

      <MachineRemoveDialog
        target={removeOpen ? host : null}
        onOpenChange={setRemoveOpen}
        onRemoved={() => navigate(getSettingsRoutePath("machines"))}
      />

      <MachineReconnectDialog
        target={reconnectOpen ? host : null}
        onOpenChange={setReconnectOpen}
      />
    </PageShell>
  );
}
