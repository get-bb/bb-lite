import { Link, useNavigate, useParams } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import { cn } from "@bb/shared-ui/lib/utils";
import { ResourceOverflowMenu } from "@bb/shared-ui/resource-list";
import { MachineLabel } from "@/components/machines/MachineLabel";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import {
  SERVER_MACHINE_REMOVE_DISABLED_REASON,
  machineRemovalConsequences,
  machineStatusLabel,
  useMachineDialogs,
} from "@/components/machines/machine-dialogs";
import { PLATFORM_LABELS } from "@/components/settings/MachinesSettingsSection";
import {
  SettingsBackLink,
  SettingsDetailShell,
} from "@/components/settings/SettingsDropdown";
import { PageShell } from "@/components/ui/page-shell.js";
import {
  SettingsBadge,
  SettingsDetailRow,
  SettingsRow,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section";
import {
  useSetHostSharing,
  useUpdateHostPermissionCeiling,
} from "@/hooks/mutations/host-mutations";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useCurrentUser, useUserDirectory } from "@/hooks/queries/user-queries";
import { useLocalHostId } from "@/hooks/useOpenTargets";
import {
  MACHINE_SHARING_OPTIONS,
  canManageMachine,
  isMachineOwner,
  machineOwnerName,
  machineSharingDescription,
} from "@/lib/machine-access";
import { showMutationErrorToast } from "@/lib/mutation-errors";
import { PERMISSION_MODE_OPTIONS } from "@/lib/permission-mode-options";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  getSettingsProjectRoutePath,
  getSettingsRoutePath,
} from "@/lib/route-paths";

export function MachineSettingsView() {
  const { hostId } = useParams<{ hostId: string }>();
  const navigate = useNavigate();
  const hosts = useHosts().data;
  const systemConfig = useSystemConfig().data;
  const localHostId = useLocalHostId();
  const navigation = useSidebarNavigation().data;
  const updatePermissionCeiling = useUpdateHostPermissionCeiling();
  const setSharing = useSetHostSharing();
  const currentUser = useCurrentUser();
  const users = useUserDirectory();
  const dialogs = useMachineDialogs(hosts, () =>
    navigate(getSettingsRoutePath("machines")),
  );
  const host = hosts?.find((candidate) => candidate.id === hostId) ?? null;

  if (hosts === undefined) {
    return (
      <SettingsDetailShell section="machines" label="Machines">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </SettingsDetailShell>
    );
  }
  if (host === null) {
    return (
      <SettingsDetailShell section="machines" label="Machines">
        <p className="text-sm text-muted-foreground">
          Machine is no longer paired.
        </p>
      </SettingsDetailShell>
    );
  }

  const isPrimary = host.id === systemConfig?.primaryHostId;
  const platform =
    isPrimary && systemConfig?.primaryHostPlatform
      ? PLATFORM_LABELS[systemConfig.primaryHostPlatform]
      : null;
  const projects = (navigation?.projects ?? []).filter((project) =>
    project.sources.some((source) => source.hostId === host.id),
  );
  const canManage = canManageMachine(host, currentUser);
  const viewerIsOwner =
    currentUser === null || isMachineOwner(host, currentUser);
  const otherOwnerName = viewerIsOwner ? null : machineOwnerName(host, users);
  const describedOwnerName =
    viewerIsOwner || (canManage && host.ownerUserId === null)
      ? null
      : (otherOwnerName ?? "its owner");
  const pendingSharing = setSharing.isPending
    ? setSharing.variables.sharing
    : null;
  const sharing = pendingSharing ?? host.sharing;
  const sharingDescription = canManage
    ? otherOwnerName === null
      ? "Who can run threads on this machine."
      : `Owned by ${otherOwnerName}.`
    : otherOwnerName === null
      ? "Only the machine's owner or an owner of this bb can change this."
      : `Owned by ${otherOwnerName}. Only they or an owner of this bb can change this.`;
  const paired = `paired ${formatRelativeTime({ timestamp: host.createdAt, now: Date.now() })}`;

  return (
    <PageShell contentClassName="pt-4 md:pt-5">
      <div className="mx-auto w-full max-w-3xl space-y-6 pb-10">
        <div className="space-y-3">
          <SettingsBackLink section="machines" label="Machines" />
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="min-w-0 text-sm font-semibold text-foreground">
                  <MachineLabel host={host} />
                </h1>
                {host.id === localHostId &&
                hosts.filter((other) => other.type === "persistent").length >
                  1 ? (
                  <SettingsBadge>This machine</SettingsBadge>
                ) : null}
                {isPrimary ? <SettingsBadge>Server</SettingsBadge> : null}
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <MachineStatusDot connected={host.status === "connected"} />
                <p className="min-w-0 text-xs text-subtle-foreground/75">
                  {[machineStatusLabel(host), platform, paired]
                    .filter((part) => part !== null)
                    .join(" · ")}
                </p>
              </div>
            </div>
            {canManage ? (
              <div className="flex shrink-0 items-center gap-2">
                <ResourceOverflowMenu
                  label={`${host.name} actions`}
                  items={dialogs.menuItems(host, isPrimary, false)}
                />
              </div>
            ) : null}
          </div>
        </div>

        <SettingsSection
          title="Permission limit"
          description="Highest permission mode any thread on the selected machine may run with. Threads that ask for more resolve down to it, and a provider that supports nothing this low can't run here."
        >
          <div role="radiogroup" aria-label="Permission limit">
            <SettingsRowList>
              {PERMISSION_MODE_OPTIONS.map((option) => {
                const selected = option.value === host.maxPermissionMode;
                return (
                  <SettingsRow key={option.value} className="items-start">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={!canManage || updatePermissionCeiling.isPending}
                      onClick={() => {
                        if (selected) return;
                        updatePermissionCeiling.mutate(
                          { hostId: host.id, maxPermissionMode: option.value },
                          {
                            onError: (error) =>
                              showMutationErrorToast({
                                error,
                                fallbackMessage: `Couldn't change the permission limit for ${host.name}.`,
                              }),
                          },
                        );
                      }}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        (!canManage || updatePermissionCeiling.isPending) &&
                          "opacity-70",
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
        </SettingsSection>

        <SettingsSection title="Sharing" description={sharingDescription}>
          <div role="radiogroup" aria-label="Sharing">
            <SettingsRowList>
              {MACHINE_SHARING_OPTIONS.map((option) => {
                const selected = option.value === sharing;
                return (
                  <SettingsRow key={option.value} className="items-start">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={!canManage || setSharing.isPending}
                      onClick={() => {
                        if (selected) return;
                        setSharing.mutate(
                          { hostId: host.id, sharing: option.value },
                          {
                            onError: (error) =>
                              showMutationErrorToast({
                                error,
                                fallbackMessage: `Couldn't change sharing for ${host.name}.`,
                              }),
                          },
                        );
                      }}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        (!canManage || setSharing.isPending) && "opacity-70",
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
                        <span className="mt-0.5 block text-xs leading-snug text-subtle-foreground/75">
                          {machineSharingDescription(
                            option.value,
                            describedOwnerName,
                          )}
                        </span>
                      </span>
                    </button>
                  </SettingsRow>
                );
              })}
            </SettingsRowList>
          </div>
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
          </SettingsRowList>
        </SettingsSection>

        {canManage ? (
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
                  onClick={() => dialogs.openRemove(host)}
                >
                  Remove machine
                </Button>
              </SettingsRow>
            </SettingsRowList>
          </SettingsSection>
        ) : null}
      </div>
      {dialogs.dialogs}
    </PageShell>
  );
}
