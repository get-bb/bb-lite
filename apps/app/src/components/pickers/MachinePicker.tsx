import { useRef, useState } from "react";
import type { Host } from "@bb/domain";
import { Icon } from "@bb/shared-ui/icon";
import { Button } from "@bb/shared-ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@bb/shared-ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import { selectPrimaryHost } from "@/hooks/queries/host-queries";
import { formatRelativeTime } from "@/lib/relative-time";
import { cn } from "@bb/shared-ui/lib/utils";
import { MachineLabel } from "@/components/machines/MachineLabel";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
  OPTION_TRIGGER_CONTENT_CLASS_NAME,
} from "@bb/shared-ui/option-display";
import { searchMachineHosts, useResetPickerScroll } from "./picker-search";

export const MACHINE_BADGE_CLASS_NAME =
  "shrink-0 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-2xs leading-none text-subtle-foreground";

export function orderLocalHostFirst(
  hosts: readonly Host[],
  localHostId: string | null,
): Host[] {
  return [...hosts].sort(
    (left, right) =>
      Number(left.id !== localHostId) - Number(right.id !== localHostId),
  );
}

export function MachinePicker({
  hosts,
  localHostId,
  primaryHostId,
  selectedHostId,
  onChange,
}: {
  hosts: readonly Host[];
  localHostId: string | null;
  primaryHostId: string | null;
  selectedHostId: string | null;
  onChange: (hostId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const commandRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useResetPickerScroll<HTMLDivElement>(searchQuery);
  const selectedHost =
    hosts.find((host) => host.id === selectedHostId) ??
    selectPrimaryHost(hosts, primaryHostId);
  const orderedHosts = orderLocalHostFirst(hosts, localHostId);
  const showSearch = hosts.length > 5;
  const filteredHosts = showSearch
    ? searchMachineHosts(orderedHosts, searchQuery)
    : orderedHosts;
  const now = Date.now();
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setSearchQuery("");
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange} modal>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Machine"
          data-promptbox-shrinkable-control=""
          className={cn(
            OPTION_BASE_CLASS_NAME,
            OPTION_INTERACTIVE_CLASS_NAME,
            LIST_HOVER_TRANSITION,
            OPTION_MUTED_CLASS_NAME,
            "shrink-0",
          )}
        >
          <span className={OPTION_TRIGGER_CONTENT_CLASS_NAME}>
            {selectedHost == null ? (
              <span className="min-w-0 truncate">Machine</span>
            ) : (
              <MachineLabel
                host={selectedHost}
                iconClassName="size-3.5 shrink-0"
              />
            )}
          </span>
          <Icon
            name="ChevronDown"
            className="shrink-0 text-muted-foreground size-3.5"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Machine"
        autoFocusRef={showSearch ? searchInputRef : commandRef}
        className="flex max-h-[min(var(--radix-popover-content-available-height),calc(100dvh-0.5rem))] w-72 flex-col overflow-hidden p-0"
      >
        <Command
          ref={commandRef}
          label="Search machines"
          shouldFilter={false}
          className="min-h-0"
        >
          {showSearch ? (
            <CommandInput
              ref={searchInputRef}
              aria-label="Search machines"
              placeholder="Search machines"
              value={searchQuery}
              onValueChange={setSearchQuery}
              className="h-8 text-xs"
            />
          ) : null}
          <CommandList
            ref={listRef}
            className="min-h-0 max-h-none flex-1 overscroll-contain"
          >
            <CommandGroup>
              {filteredHosts.map((host) => {
                const connected = host.status === "connected";
                return (
                  <CommandItem
                    key={host.id}
                    value={host.id}
                    disabled={!connected}
                    aria-current={
                      host.id === selectedHost?.id ? "true" : undefined
                    }
                    onSelect={() => {
                      if (!connected) return;
                      onChange(host.id);
                      handleOpenChange(false);
                    }}
                    className={cn(
                      "flex items-center justify-between gap-3 py-[0.3125rem] text-xs",
                      LIST_HOVER_TRANSITION,
                    )}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      <MachineStatusDot connected={connected} />
                      <MachineLabel
                        host={host}
                        iconClassName="size-3"
                        nameClassName="text-xs"
                      />
                      {host.id === localHostId ? (
                        <span className={MACHINE_BADGE_CLASS_NAME}>
                          this machine
                        </span>
                      ) : null}
                    </span>
                    {!connected && host.lastSeenAt !== null ? (
                      <span className="shrink-0 text-2xs text-muted-foreground">
                        last seen{" "}
                        {formatRelativeTime({
                          timestamp: host.lastSeenAt,
                          now,
                        })}
                      </span>
                    ) : null}
                    <Icon
                      name="Check"
                      className={cn(
                        "size-4 shrink-0",
                        host.id === selectedHost?.id
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                    />
                  </CommandItem>
                );
              })}
              {showSearch && filteredHosts.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  No machines found
                </div>
              ) : null}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
