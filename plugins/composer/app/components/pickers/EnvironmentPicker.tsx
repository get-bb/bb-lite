import { EnvironmentProviderIcon } from "@bb/app-kit/components/plugin/EnvironmentProviderIcon";
import { useRef, useState } from "react";
import {
  findLocalPathProjectSourceForHost,
  type Host,
  type ProjectSource,
  type User,
} from "@bb/domain";
import type { SystemEnvironmentProvider } from "@bb/server-contract";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { pluginIconName } from "@bb/app-kit/components/plugin/PluginIcon";
import { Button } from "@bb/shared-ui/button";
import { Skeleton } from "@bb/shared-ui/skeleton";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@bb/shared-ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_DOT_SIZE_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import { MachineStatusDot } from "@bb/app-kit/components/machines/MachineStatusDot";
import { REUSE_ENVIRONMENT_ICON_NAME } from "@bb/app-kit/lib/environment-workspace-display";
import { formatRelativeTime } from "@bb/app-kit/lib/relative-time";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
  OPTION_TRIGGER_CONTENT_CLASS_NAME,
} from "@bb/shared-ui/option-display";
import {
  encodeProviderValue,
  parseEnvironmentValue,
} from "@bb/app-kit/components/pickers/environment-picker-value";
import { selectPrimaryHost } from "@bb/app-kit/hooks/queries/host-queries";
import {
  PickerLoadingRows,
  searchMachineHosts,
  useResetPickerScroll,
} from "./picker-search";
import { MachineIcon } from "@bb/app-kit/components/machines/MachineLabel";
import {
  isHostUsable,
  privateMachineHint,
} from "@bb/app-kit/lib/machine-access";

const MACHINE_BADGE_CLASS_NAME =
  "shrink-0 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-2xs leading-none text-subtle-foreground";

export interface EnvironmentPickerProps {
  value: string;
  sources: readonly ProjectSource[];
  hosts: readonly Host[];
  users?: ReadonlyMap<string, User>;
  localHostId: string | null;
  primaryHostId: string | null;
  selectedProviderHostId: string | null;
  providers: readonly SystemEnvironmentProvider[];
  providersByHostId: ReadonlyMap<
    string,
    readonly SystemEnvironmentProvider[] | undefined
  >;
  disabled?: boolean;
  isLoading?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestMachineSetup?: (host: Host) => void;
  onSelectProvider: (
    provider: SystemEnvironmentProvider,
    hostId: string,
  ) => void;
  onSelectHost: (hostId: string) => void;
  onSelectReuse: () => void;
}

export function EnvironmentPicker({
  value,
  sources,
  hosts,
  users,
  localHostId,
  primaryHostId,
  selectedProviderHostId,
  providers,
  providersByHostId,
  disabled = false,
  isLoading = false,
  open,
  onOpenChange,
  onRequestMachineSetup,
  onSelectProvider,
  onSelectHost,
  onSelectReuse,
}: EnvironmentPickerProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [previewHostId, setPreviewHostId] = useState<string | null>(null);
  const [commandValueOverride, setCommandValueOverride] = useState<
    string | null
  >(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const machineListRef = useResetPickerScroll<HTMLDivElement>(searchQuery);
  const now = Date.now();

  const parsed = parseEnvironmentValue(value);
  const selectedProvider =
    parsed?.type === "provider"
      ? providers.find(
          (provider) => provider.id === parsed.environmentProviderId,
        )
      : undefined;
  const primaryHost = selectPrimaryHost(hosts, primaryHostId);
  const findHost = (hostId: string | null) =>
    hosts.find((host) => host.id === hostId);
  const selectedHost =
    parsed?.type === "provider" && selectedProviderHostId !== null
      ? (findHost(selectedProviderHostId) ?? primaryHost)
      : primaryHost;
  const hostUnavailableReason = !selectedHost
    ? "No host connected"
    : selectedHost.status !== "connected"
      ? "Host is offline"
      : null;
  const selectedMachineName =
    hosts.length > 1 && parsed?.type === "provider"
      ? (findHost(selectedProviderHostId)?.name ?? null)
      : null;
  const withMachine = (label: string) =>
    selectedMachineName ? `${selectedMachineName} · ${label}` : label;
  const trigger: { label: string; compactLabel: string; icon: IconName } =
    hostUnavailableReason !== null
      ? {
          label: withMachine(hostUnavailableReason),
          compactLabel: selectedHost ? "Offline" : "No host",
          icon: "AlertTriangle",
        }
      : selectedProvider !== undefined
        ? {
            label: withMachine(selectedProvider.displayName),
            compactLabel: selectedProvider.displayName,
            icon: pluginIconName(selectedProvider.icon),
          }
        : parsed?.type === "reuse"
          ? {
              label: "Reuse",
              compactLabel: "Reuse",
              icon: REUSE_ENVIRONMENT_ICON_NAME,
            }
          : { label: "Environment", compactLabel: "Env", icon: "Laptop" };

  const orderedHosts = [...hosts].sort(
    (left, right) =>
      Number(left.id !== localHostId) - Number(right.id !== localHostId),
  );
  const findUsableHost = (hostId: string | null) =>
    orderedHosts.find((host) => host.id === hostId && isHostUsable(host));
  const activeHost =
    findUsableHost(previewHostId) ??
    findUsableHost(
      parsed?.type === "provider"
        ? selectedProviderHostId
        : (selectedHost?.id ?? null),
    ) ??
    findUsableHost(localHostId) ??
    findUsableHost(primaryHostId) ??
    orderedHosts.find(isHostUsable);
  const activeSource = activeHost
    ? findLocalPathProjectSourceForHost(sources, activeHost.id)
    : undefined;
  const activeConnected = activeHost?.status === "connected";
  const isSelected = (provider: SystemEnvironmentProvider, hostId: string) =>
    value === encodeProviderValue(provider.id) &&
    selectedProviderHostId === hostId;
  const activeProviders = activeHost
    ? providers
        .flatMap(
          (provider) =>
            providersByHostId
              .get(activeHost.id)
              ?.find((candidate) => candidate.id === provider.id) ?? [],
        )
        .filter(
          (provider) =>
            provider.availability?.status !== "unavailable" ||
            isSelected(provider, activeHost.id),
        )
    : [];
  const filteredHosts = searchMachineHosts(orderedHosts, searchQuery);

  const changeOpen = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    setCommandValueOverride(null);
    if (!nextOpen) {
      setSearchQuery("");
      setPreviewHostId(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={changeOpen} modal={false}>
      <PopoverTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Environment"
          aria-busy={isLoading}
          disabled={disabled}
          data-promptbox-shrinkable-control=""
          className={cn(
            OPTION_BASE_CLASS_NAME,
            !disabled && OPTION_INTERACTIVE_CLASS_NAME,
            !disabled && LIST_HOVER_TRANSITION,
            OPTION_MUTED_CLASS_NAME,
            disabled && "cursor-default disabled:opacity-100",
            "shrink-0",
          )}
        >
          <span className={OPTION_TRIGGER_CONTENT_CLASS_NAME}>
            {selectedProvider === undefined ? (
              <Icon
                name={isLoading ? "Spinner" : trigger.icon}
                className={cn(
                  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
                  isLoading && "animate-spin",
                )}
              />
            ) : (
              <EnvironmentProviderIcon
                provider={selectedProvider}
                className={COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS}
              />
            )}
            {isLoading ? (
              <>
                <span className="sr-only">Loading environments</span>
                <Skeleton
                  aria-hidden
                  data-environment-loading-placeholder="trigger"
                  className="h-3 w-20 shrink-0 rounded-sm"
                />
              </>
            ) : (
              <>
                <span className="min-w-0 truncate" data-promptbox-full-label="">
                  {trigger.label}
                </span>
                <span
                  className="min-w-0 truncate"
                  data-promptbox-compact-label=""
                  data-promptbox-hide-tiny=""
                >
                  {trigger.compactLabel}
                </span>
              </>
            )}
          </span>
          {disabled ? null : (
            <Icon
              name="ChevronDown"
              className={cn(
                "shrink-0 text-muted-foreground",
                COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
              )}
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Environment"
        mobileTitle="Environment"
        autoFocusRef={isLoading ? undefined : searchInputRef}
        className="flex max-h-[min(var(--available-height),calc(100dvh-0.5rem))] w-auto max-w-80 min-w-52 flex-col overflow-hidden p-0 max-md:min-h-0 max-md:w-full max-md:flex-1"
      >
        {isLoading ? (
          <PickerLoadingRows
            label="Loading environments"
            rowDataAttribute="data-environment-loading-row"
          />
        ) : (
          <Command
            label="Search machines"
            shouldFilter={false}
            value={
              commandValueOverride ??
              (activeHost ? `machine:${activeHost.id}` : "")
            }
            onValueChange={setCommandValueOverride}
            className="min-h-0"
          >
            <CommandInput
              ref={searchInputRef}
              aria-label="Search machines"
              placeholder="Search machines"
              value={searchQuery}
              onValueChange={setSearchQuery}
              className="h-8 text-xs"
            />
            <CommandList className="min-h-0 max-h-none flex-1 overscroll-contain flex flex-col overflow-hidden">
              <div
                ref={machineListRef}
                data-machine-picker-list=""
                className="max-h-48 min-h-0 flex-1 overflow-y-auto overscroll-contain"
              >
                <CommandGroup heading="Machines">
                  {filteredHosts.map((host) => (
                    <CommandItem
                      key={host.id}
                      value={`machine:${host.id}`}
                      aria-label={host.name}
                      aria-current={
                        host.id === activeHost?.id ? "true" : undefined
                      }
                      disabled={!isHostUsable(host)}
                      onSelect={() => {
                        if (!isHostUsable(host)) return;
                        setPreviewHostId(host.id);
                        onSelectHost(host.id);
                      }}
                      className={cn(
                        "flex items-center gap-3 py-[0.3125rem] text-xs max-md:py-2",
                        LIST_HOVER_TRANSITION,
                        host.id === activeHost?.id &&
                          "font-medium text-foreground",
                      )}
                    >
                      <span
                        data-machine-target-content=""
                        className="grid min-w-0 flex-1 grid-cols-[0.375rem_0.875rem_minmax(0,1fr)] gap-x-2 max-md:pointer-coarse:grid-cols-[0.5rem_1.25rem_minmax(0,1fr)] items-center"
                      >
                        <MachineStatusDot
                          connected={host.status === "connected"}
                          className={COARSE_POINTER_DOT_SIZE_CLASS}
                        />
                        <span
                          data-machine-target-icon=""
                          className={
                            COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS
                          }
                        >
                          <MachineIcon className="!size-full" />
                        </span>
                        <span className="min-w-0 truncate text-xs">
                          {host.name}
                        </span>
                      </span>
                      {!isHostUsable(host) ? (
                        <span className="shrink-0 text-2xs text-muted-foreground">
                          {privateMachineHint(host, users)}
                        </span>
                      ) : host.id === localHostId ? (
                        <span className={MACHINE_BADGE_CLASS_NAME}>
                          this machine
                        </span>
                      ) : null}
                      <CheckIcon visible={host.id === activeHost?.id} />
                    </CommandItem>
                  ))}
                  {filteredHosts.length === 0 ? (
                    <div className="px-2 py-[0.3125rem] text-xs text-muted-foreground max-md:py-2">
                      No machines found
                    </div>
                  ) : null}
                </CommandGroup>
              </div>
              {activeHost ? (
                <>
                  <CommandSeparator className="mx-0 shrink-0" />
                  <div className="shrink-0">
                    <CommandGroup
                      heading={
                        <span className="flex items-center gap-1.5">
                          <span className="min-w-0 truncate">
                            On {activeHost.name}
                          </span>
                          {!activeConnected &&
                          activeHost.lastSeenAt !== null ? (
                            <span className="ml-auto shrink-0 pl-2 text-2xs">
                              last seen{" "}
                              {formatRelativeTime({
                                timestamp: activeHost.lastSeenAt,
                                now,
                              })}
                            </span>
                          ) : null}
                        </span>
                      }
                    >
                      {activeProviders.map((provider) => (
                        <EnvironmentMenuItem
                          key={provider.id}
                          value={`provider:${activeHost.id}:${provider.id}`}
                          label={provider.displayName}
                          description={
                            activeConnected
                              ? provider.availability?.status ===
                                  "setup-required" ||
                                provider.availability?.status === "unavailable"
                                ? provider.availability.message
                                : undefined
                              : undefined
                          }
                          icon={
                            <EnvironmentProviderIcon
                              provider={provider}
                              className={cn(
                                "mt-px text-muted-foreground max-md:pointer-coarse:mt-0",
                                COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
                              )}
                            />
                          }
                          selected={isSelected(provider, activeHost.id)}
                          disabled={
                            !activeConnected ||
                            activeHost.lifecycle.phase !== "active" ||
                            provider.availability?.status === "unavailable"
                          }
                          onSelect={() => {
                            onSelectProvider(provider, activeHost.id);
                            changeOpen(false);
                          }}
                        />
                      ))}
                      {activeSource !==
                      undefined ? null : onRequestMachineSetup &&
                        activeConnected ? (
                        <EnvironmentMenuItem
                          value={`setup:${activeHost.id}`}
                          label={`Set up on ${activeHost.name}…`}
                          icon={<MenuIcon name="Plus" />}
                          selected={false}
                          onSelect={() => {
                            onRequestMachineSetup(activeHost);
                            changeOpen(false);
                          }}
                        />
                      ) : activeProviders.length === 0 ? (
                        <CommandItem
                          value={`not-set-up:${activeHost.id}`}
                          disabled
                          className="whitespace-normal break-words text-xs text-muted-foreground"
                        >
                          Not set up for this project
                        </CommandItem>
                      ) : null}
                    </CommandGroup>
                  </div>
                </>
              ) : null}
              <CommandSeparator className="mx-0 shrink-0" />
              <CommandGroup className="shrink-0">
                <EnvironmentMenuItem
                  value="reuse"
                  label="Reuse existing"
                  icon={<MenuIcon name={REUSE_ENVIRONMENT_ICON_NAME} />}
                  selected={parsed?.type === "reuse"}
                  onSelect={() => {
                    onSelectReuse();
                    changeOpen(false);
                  }}
                />
              </CommandGroup>
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}

function MenuIcon({ name }: { name: IconName }) {
  return (
    <Icon
      name={name}
      className={cn(
        "mt-px text-muted-foreground max-md:pointer-coarse:mt-0",
        COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
      )}
    />
  );
}

function CheckIcon({ visible }: { visible: boolean }) {
  return (
    <Icon
      name="Check"
      className={cn(
        COARSE_POINTER_ICON_SIZE_CLASS,
        "shrink-0",
        visible ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

function EnvironmentMenuItem({
  value,
  label,
  description,
  icon,
  selected,
  onSelect,
  disabled,
}: {
  value: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <CommandItem
      value={value}
      disabled={disabled}
      aria-current={selected ? "true" : undefined}
      onSelect={() => {
        if (!disabled) onSelect();
      }}
      className={cn(
        "flex items-start justify-between gap-3 whitespace-normal",
        "py-[0.3125rem] text-xs max-md:py-2",
        LIST_HOVER_TRANSITION,
      )}
    >
      <span className="flex min-w-0 flex-1 gap-2 items-start">
        {icon}
        <span className="flex min-w-0 flex-col">
          <span className="whitespace-normal break-words text-xs">{label}</span>
          {description ? (
            <span className="mt-0.5 whitespace-normal break-words text-xs leading-snug text-muted-foreground">
              {description}
            </span>
          ) : null}
        </span>
      </span>
      <CheckIcon visible={selected} />
    </CommandItem>
  );
}
