import { useState } from "react";
import {
  Icon,
  machines,
  ProviderIcon,
  settings,
  shell,
  useCall,
  useOp,
  useProviders,
  type PluginAppApi,
} from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bb/shared-ui/select";
import { SIDEBAR_FOOTER_ACTION_CLASS } from "@bb/shared-ui/sidebar-row-classes";
import { Skeleton } from "@bb/shared-ui/skeleton";
import {
  formatReset,
  providerUsage,
  statusText,
  type ProviderUsage,
  type UsageAccount,
  type UsageSnapshot,
  type UsageWindow,
} from "./contract";

const SHARED = "shared";
const STORAGE_KEY = "bb.provider-usage.machine";

function highestPercent(snapshot: UsageSnapshot | undefined): number {
  return Math.max(
    0,
    ...(snapshot?.providers ?? []).flatMap((provider) =>
      provider.accounts.flatMap((account) =>
        account.usage.status === "ok"
          ? account.usage.windows.map((window) => window.usedPercent)
          : [],
      ),
    ),
  );
}

function toneClass(usedPercent: number, kind: "bg" | "text"): string {
  if (usedPercent >= 95) return `${kind}-destructive`;
  if (usedPercent >= 80) return `${kind}-warning`;
  return kind === "bg" ? "bg-primary" : "text-muted-foreground";
}

function formatCents(cents: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

function WindowRow({ window }: { window: UsageWindow }) {
  const reset = formatReset(window.resetsAt, Date.now());
  const value =
    window.cost === null
      ? `${Math.round(window.usedPercent)}%`
      : `${formatCents(window.cost.usedUsdCents)} / ${formatCents(window.cost.limitUsdCents)}`;
  return (
    <div
      className="flex flex-col gap-1 text-xs"
      aria-label={`${window.label}: ${value} used. ${reset ?? "Reset time not reported"}`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-muted-foreground">{window.label}</span>
        <span
          className={`tabular-nums ${toneClass(window.usedPercent, "text")}`}
        >
          {value}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-border">
        <div
          className={`h-full rounded-full ${toneClass(window.usedPercent, "bg")}`}
          style={{
            width: `${Math.max(2, Math.min(100, window.usedPercent))}%`,
          }}
        />
      </div>
      {reset === null ? null : (
        <span className="text-2xs text-subtle-foreground">
          {reset.charAt(0).toUpperCase() + reset.slice(1)}
        </span>
      )}
    </div>
  );
}

function AccountRows({ account }: { account: UsageAccount }) {
  const usage = account.usage;
  const name =
    account.label ?? (usage.status === "ok" ? usage.accountEmail : null);
  const plan = usage.status === "ok" ? usage.planLabel : null;
  const message = statusText(usage);
  return (
    <div className="flex flex-col gap-2">
      {name === null && plan === null ? null : (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="truncate">{name}</span>
          {plan === null ? null : (
            <span className="rounded bg-muted px-1.5 text-2xs text-muted-foreground">
              {plan}
            </span>
          )}
        </div>
      )}
      {message === "" ? null : (
        <p className="text-xs text-muted-foreground">{message}</p>
      )}
      {usage.status === "ok"
        ? usage.windows.map((window) => (
            <WindowRow key={window.label} window={window} />
          ))
        : null}
    </div>
  );
}

function ProviderBlock({ provider }: { provider: ProviderUsage }) {
  const { providers } = useProviders();
  const info = providers.find((item) => item.id === provider.providerId);
  return (
    <section className="flex flex-col gap-3">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <ProviderIcon
          providerKind="agent"
          provider={info ?? { id: provider.providerId }}
          className="size-4"
          aria-hidden="true"
        />
        {provider.displayName}
      </h3>
      {provider.error === null ? null : (
        <p className="text-xs text-warning">
          {provider.accounts.length > 0
            ? `${provider.error} Showing the last reading.`
            : provider.error}
        </p>
      )}
      {provider.accounts.map((account, index) => (
        <AccountRows key={account.accountKey ?? index} account={account} />
      ))}
    </section>
  );
}

function UsagePanel() {
  const [machine, setMachine] = useState(
    () => localStorage.getItem(STORAGE_KEY) ?? SHARED,
  );
  const [refreshing, setRefreshing] = useState(false);
  const hosts = useOp(machines.list, {});
  const hostId = machine === SHARED ? null : machine;
  const usage = useOp(providerUsage.usage, { hostId });
  const read = useCall(providerUsage.usage);
  const choose = (value: string) => {
    localStorage.setItem(STORAGE_KEY, value);
    setMachine(value);
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      await read({ hostId, refresh: true });
      await usage.refetch();
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Select value={machine} onValueChange={choose}>
          <SelectTrigger className="h-8 min-w-0 flex-1 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SHARED}>Shared accounts</SelectItem>
            {(hosts.data ?? []).map((host) => (
              <SelectItem key={host.id} value={host.id}>
                {host.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Reload usage"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          <Icon name="RotateCcw" className="size-4" aria-hidden="true" />
        </Button>
      </div>
      {usage.status === "loading" && usage.data === undefined ? (
        <Skeleton className="h-16 w-full" />
      ) : usage.error && usage.data === undefined ? (
        <p className="text-xs text-destructive">Usage could not be loaded.</p>
      ) : (usage.data?.providers.length ?? 0) === 0 ? (
        <p className="text-xs text-muted-foreground">
          No provider reports usage here.
        </p>
      ) : (
        usage.data?.providers.map((provider) => (
          <ProviderBlock key={provider.providerId} provider={provider} />
        ))
      )}
    </div>
  );
}

function UsageFooter() {
  const usage = useOp(providerUsage.usage, { hostId: null });
  const percent = highestPercent(usage.data);
  return (
    <li className="min-w-0 shrink-0">
      <Popover onOpenChange={(open) => void (open && usage.refetch())}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Provider usage"
            title="Provider usage"
            className={`flex size-8 items-center justify-center rounded-md ${SIDEBAR_FOOTER_ACTION_CLASS} ${percent >= 80 ? toneClass(percent, "text") : ""}`}
          >
            <Icon name="ChartColumn" className="size-4" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-80 p-3">
          <UsagePanel />
        </PopoverContent>
      </Popover>
    </li>
  );
}

export default function providerUsageApp(bb: PluginAppApi): void {
  bb.add(settings.section, {
    id: "usage",
    title: "Usage",
    description: "Each provider's usage limits and when they reset.",
    view: UsagePanel,
  });
  bb.add(shell.sidebarFooter, {
    id: "usage",
    label: "Provider usage",
    icon: "ChartColumn",
    view: UsageFooter,
  });
}
