import { useCallback, useEffect, useState, type ReactNode } from "react";
import { callOp, plugin, useBbNavigate, useChanged } from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import { ResourceRowDetailChevron } from "@bb/shared-ui/resource-list";
import { Switch } from "@bb/shared-ui/switch";
import {
  pool,
  type AccountSummary,
  type LimitWindow,
  type LoginStart,
  type PoolProvider,
  type PoolStatus,
} from "./src/contract.js";

type DialogState =
  | { kind: "account"; id: string }
  | { kind: "login"; provider: PoolProvider }
  | null;
type Menu = { icon: string; title: string; hint?: string; run(): void }[];

const PROVIDERS = [
  ["claude", "Claude", "Claude Code threads on every machine"],
  ["codex", "Codex", "Codex threads"],
] as const;
const CLAUDE_SLOTS = ["5h", "7d", "7d:fable"];
const WINDOW_NAMES: Record<string, [short: string, long: string]> = {
  "5h": ["5H", "5 hour"],
  "7d": ["7D", "7 day"],
  primary: ["LIMIT", "Usage limit"],
  secondary: ["LIMIT 2", "Secondary limit"],
};
const STATUS_DOTS = {
  held: "bg-warning",
  exhausted: "bg-destructive",
  error: "bg-destructive",
  disabled: "bg-muted-foreground",
  ready: "bg-success",
};
const TONES = {
  spent: { text: "text-destructive-text", bar: "bg-destructive" },
  near: { text: "text-warning-text", bar: "bg-warning" },
  fine: { text: "text-foreground", bar: "bg-primary" },
};
const MUTED = "text-xs text-subtle-foreground/75";

function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function resetLabel(timestamp: number): string {
  const minutes = Math.max(1, Math.round((timestamp - Date.now()) / 60_000));
  const clock = `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  if (minutes < 1_440)
    return `resets in ${minutes >= 60 ? clock : `${minutes}m`}`;
  const format = { month: "short", day: "numeric" } as const;
  return `resets ${new Intl.DateTimeFormat(undefined, format).format(timestamp)}`;
}

function windowName({ key, minutes }: LimitWindow, long: boolean): string {
  const family = key.slice(key.indexOf(":") + 1);
  const scope = key.includes(":") ? " 7 day" : "";
  const title = `${family[0]?.toUpperCase()}${family.slice(1)}${scope}`;
  const named = WINDOW_NAMES[key] ?? [family.toUpperCase(), title];
  if (minutes === null) return named[long ? 1 : 0];
  const hours: [number, string] =
    minutes % 60 === 0 ? [minutes / 60, "hour"] : [minutes, "minute"];
  const [count, unit] =
    minutes % 1_440 === 0 ? [minutes / 1_440, "day"] : hours;
  if (!long) return `${count}${unit[0]?.toUpperCase()}`;
  return minutes === 10_080 ? "Weekly" : `${count} ${unit}`;
}

function slots({ provider, windows }: AccountSummary, all = false) {
  const blank = { minutes: null, utilization: null, resetAt: null };
  const find = (key: string): LimitWindow =>
    windows.find((window) => window.key === key) ??
    Object.assign({ key, status: null }, blank);
  if (provider !== "claude")
    return windows.length ? windows : [find("primary")];
  if (!all) return CLAUDE_SLOTS.map(find);
  const scoped = windows.filter(({ key }) => key !== "5h" && key !== "7d");
  return [find("5h"), find("7d"), ...scoped];
}

function tone({ status, utilization }: LimitWindow, threshold: number) {
  const used = utilization ?? 0;
  if (status === "rejected" || used >= 1) return TONES.spent;
  return used >= threshold - 0.1 ? TONES.near : TONES.fine;
}

function statusLabel({ status, blockedUntil, heldUntil }: AccountSummary) {
  const clock = { hour: "2-digit", minute: "2-digit" } as const;
  const retry = new Intl.DateTimeFormat(undefined, clock).format(
    heldUntil ?? 0,
  );
  const reset = blockedUntil === null ? "" : ` · ${resetLabel(blockedUntil)}`;
  if (status === "held") return `Held · retry at ${retry}`;
  if (status === "exhausted") return `Exhausted${reset}`;
  return `${status[0]?.toUpperCase()}${status.slice(1)}`;
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-2xs leading-none text-subtle-foreground">
      {children}
    </span>
  );
}

function ActionMenu({ label, menu }: { label: ReactNode; menu: Menu }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{label}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {menu.map(({ icon, title, hint, run }) => (
          <DropdownMenuItem key={title} className="items-start" onSelect={run}>
            <Icon name={icon} className="mt-0.5" />
            <span>
              <span className="block">{title}</span>
              <span className="block text-xs text-muted-foreground">
                {hint}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AccountRow(props: {
  account: AccountSummary;
  threshold: number;
  menu: Menu;
  onOpen(): void;
}) {
  const { account, threshold, menu, onOpen } = props;
  const { label, email, kind, status } = account;
  const fallback = kind === "api-key" ? "API key" : "OAuth";
  const more = (
    <Button variant="ghost" size="icon" aria-label={`${label} actions`}>
      <Icon name="MoreHorizontal" className="size-4" />
    </Button>
  );
  return (
    <div
      className={cn(
        "group -mx-2 flex items-center gap-2 rounded-md px-2 py-2.5 text-sm transition-colors hover:bg-state-hover",
        !account.enabled && "opacity-55",
      )}
    >
      <button
        type="button"
        className="grid min-w-0 flex-1 grid-cols-1 items-center gap-y-1.5 text-left sm:grid-cols-[minmax(0,1fr)_auto]"
        aria-label={`Open ${label}`}
        onClick={onOpen}
      >
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="truncate font-medium text-foreground">
              {label}
            </span>
            {email !== null && email !== label ? (
              <span className={cn("min-w-0 truncate", MUTED)}>{email}</span>
            ) : null}
            <Badge>{account.subscriptionType ?? fallback}</Badge>
            {account.extraUsage ? <Badge>Extra usage available</Badge> : null}
          </div>
          <div className={cn("flex flex-wrap items-center gap-x-3", MUTED)}>
            <span className="inline-flex items-center gap-1.5">
              <span
                className={cn("size-1.5 rounded-full", STATUS_DOTS[status])}
              />
              {statusLabel(account)}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 sm:flex-nowrap sm:gap-1">
          {slots(account).map((slot) => (
            <div key={slot.key} className="w-16 tabular-nums sm:text-right">
              <div className="text-2xs uppercase tracking-wide text-subtle-foreground/75">
                {windowName(slot, false)}
              </div>
              <div
                className={cn(
                  "text-xs font-semibold",
                  slot.utilization === null
                    ? MUTED
                    : tone(slot, threshold).text,
                )}
              >
                {percent(slot.utilization)}
              </div>
            </div>
          ))}
        </div>
      </button>
      <ActionMenu label={more} menu={menu} />
      <ResourceRowDetailChevron />
    </div>
  );
}

function UsageBars(props: { account: AccountSummary; threshold: number }) {
  const { account, threshold } = props;
  const limit = `will be skipped at ${Math.round(threshold * 100)}%`;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Badge>{statusLabel(account)}</Badge>
        {account.error === null ? null : (
          <span className="text-xs text-destructive-text">{account.error}</span>
        )}
      </div>
      {slots(account, true).map((slot) => (
        <div key={slot.key} className="grid grid-cols-[7rem_1fr] gap-3 text-sm">
          <div className="text-muted-foreground">{windowName(slot, true)}</div>
          <div className="min-w-0">
            <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full", tone(slot, threshold).bar)}
                style={{ width: percent(Math.min(1, slot.utilization ?? 0)) }}
              />
            </div>
            <div className="text-xs text-muted-foreground">
              {percent(slot.utilization)}
              {slot.resetAt === null
                ? ""
                : ` · ${resetLabel(slot.resetAt)}`} ·{" "}
              {limit}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function LoginSteps(props: {
  login: LoginStart;
  code: string;
  setCode(code: string): void;
  openUrl(url: string): unknown;
}) {
  const { login, code, setCode, openUrl } = props;
  const { url, device } = login;
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {device === null
          ? "Sign in at claude.ai, then paste the code from the final page."
          : "Open the verification page, sign in to ChatGPT, and enter this code."}
      </p>
      {device === null ? null : (
        <div className="select-all rounded-lg border border-border bg-surface-recessed px-4 py-4 text-center font-mono text-2xl font-semibold tracking-widest">
          {device.userCode}
        </div>
      )}
      <div className="flex gap-2">
        <Input readOnly value={url} aria-label="Authorization URL" />
        <Button
          variant="outline"
          className="shrink-0"
          onClick={() => void navigator.clipboard.writeText(url)}
        >
          Copy
        </Button>
        <Button className="shrink-0" onClick={() => openUrl(url)}>
          Open
        </Button>
      </div>
      {device === null ? (
        <Input
          aria-label="Claude authorization code"
          placeholder="Paste code#state here"
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      ) : (
        <p className="text-center text-sm text-muted-foreground">
          Waiting for you to authorize…
        </p>
      )}
    </>
  );
}

function AccountPoolSettings() {
  const { openUrl } = useBbNavigate();
  const [status, setStatus] = useState<PoolStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [login, setLogin] = useState<LoginStart | null>(null);
  const [connected, setConnected] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [threshold, setThreshold] = useState("");
  const fail = (failure: unknown) =>
    setError(failure instanceof Error ? failure.message : String(failure));
  const refresh = useCallback(async () => {
    const next = await callOp(pool.status, {}).catch(fail);
    if (next === undefined) return;
    setStatus(next);
    setThreshold(String(next.config.switchThreshold));
  }, []);
  useEffect(() => void refresh(), [refresh]);
  useChanged(pool.status, () => void refresh());
  const run = async (action: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    await action().catch(fail);
    await refresh();
    setPending(false);
  };
  const session = login?.sessionId;
  const interval = login?.device?.intervalMs;
  useEffect(() => {
    if (session === undefined || interval === undefined) return;
    const timer = window.setInterval(async () => {
      const result = await callOp(pool.loginPoll, { sessionId: session });
      if (result.status === "pending") return;
      setLogin(null);
      if (result.status === "error") return setError(result.message);
      setConnected(result.account.label);
      await refresh();
    }, interval);
    return () => window.clearInterval(timer);
  }, [session, interval, refresh]);
  const startLogin = (provider: PoolProvider) => {
    setDialog({ kind: "login", provider });
    setConnected(null);
    setCode("");
    void run(async () => setLogin(await callOp(pool.loginStart, { provider })));
  };
  const closeDialog = () => {
    setDialog(null);
    setLogin(null);
  };
  const saveThreshold = () => {
    const switchThreshold = Number(threshold);
    if (switchThreshold === limit) return;
    void run(() => callOp(pool.configSet, { switchThreshold }));
  };
  const limit = status?.config.switchThreshold ?? 0.98;
  const accounts = status?.accounts ?? [];
  const opened = accounts.find(
    (account) => dialog?.kind === "account" && account.id === dialog.id,
  );
  const machines = status?.hosts.map((host) => host.hostName ?? host.hostId);
  const name = dialog?.kind === "login" && dialog.provider === "codex";
  return (
    <div className="w-full space-y-6">
      <p className={MUTED}>
        Hub {status === null ? "loading" : "accepting"} · used by{" "}
        {machines?.join(", ") || "no machines"}
      </p>
      {error === null ? null : (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-surface-destructive px-3 py-2 text-sm text-destructive-text"
        >
          {error}
        </div>
      )}
      {PROVIDERS.map(([provider, title, scope]) => {
        const listed = accounts.filter((entry) => entry.provider === provider);
        const add = (
          <Button size="sm" variant="outline">
            <Icon name="Plus" className="size-3.5" />
            Add account
          </Button>
        );
        const imported = { provider, apiKey: null, label: null, priority: 100 };
        const addMenu: Menu = [
          {
            icon: "UserRound",
            title: `Sign in to ${title}`,
            hint: "Opens the provider's sign-in page",
            run: () => startLogin(provider),
          },
          {
            icon: "Download",
            title: "Import from this machine",
            hint: `Copies the server host's ${title} login`,
            run: () => void run(() => callOp(pool.accountAdd, imported)),
          },
        ];
        return (
          <section key={provider} className="space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-foreground">
                  {title}
                </h2>
                <p className={cn("mt-0.5 leading-snug", MUTED)}>
                  {scope} route through these accounts.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Switch
                  checked={status?.routing[provider] ?? true}
                  disabled={pending}
                  aria-label={`Route ${title} threads`}
                  onCheckedChange={(enabled) =>
                    void run(() =>
                      callOp(pool.routingSet, { provider, enabled }),
                    )
                  }
                />
                <ActionMenu label={add} menu={addMenu} />
              </div>
            </div>
            <div className="divide-y divide-border border-t border-border">
              {listed.length === 0 ? (
                <p className="py-2.5 text-sm text-subtle-foreground">
                  {status === null ? "Loading…" : "No accounts yet."}
                </p>
              ) : null}
              {listed.map((account) => {
                const { id, enabled } = account;
                const update = (patch: { enabled: boolean }) =>
                  void run(() => callOp(pool.accountUpdate, { id, ...patch }));
                const menu: Menu = [
                  {
                    icon: enabled ? "Circle" : "CircleCheck",
                    title: enabled ? "Disable" : "Enable",
                    run: () => update({ enabled: !enabled }),
                  },
                  {
                    icon: "RotateCcw",
                    title: "Refresh usage",
                    run: () =>
                      void run(() => callOp(pool.accountRefresh, { id })),
                  },
                ];
                const onOpen = () => setDialog({ kind: "account", id });
                const row = { account, threshold: limit, menu, onOpen };
                return <AccountRow key={id} {...row} />;
              })}
            </div>
          </section>
        );
      })}
      <div className="flex items-start justify-between gap-4 rounded-lg border border-border px-4 py-2.5">
        <div className="min-w-0">
          <div className="text-sm text-foreground">Quota switch threshold</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Stop selecting an account at this quota fraction.
          </div>
        </div>
        <Input
          type="number"
          min="0.01"
          max="1"
          step="0.01"
          className="w-28 shrink-0"
          aria-label="Quota switch threshold"
          disabled={status === null || pending}
          value={threshold}
          onChange={(event) => setThreshold(event.target.value)}
          onBlur={saveThreshold}
        />
      </div>
      <Dialog open={dialog !== null} onOpenChange={closeDialog}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {opened?.label ?? `Sign in to ${name ? "Codex" : "Claude"}`}
            </DialogTitle>
          </DialogHeader>
          {opened === undefined ? null : (
            <UsageBars account={opened} threshold={limit} />
          )}
          {dialog?.kind !== "login" ? null : connected !== null ? (
            <p className="text-sm text-muted-foreground">
              Connected {connected}. Threads on every machine now route through
              this account.
            </p>
          ) : login === null ? (
            <p className="text-sm text-muted-foreground">
              {error === null ? "Starting sign-in…" : "Sign-in stopped."}
            </p>
          ) : (
            <LoginSteps {...{ login, code, setCode, openUrl }} />
          )}
          {login === null || login.device !== null ? null : (
            <DialogFooter>
              <Button
                disabled={code.trim() === "" || pending}
                onClick={() =>
                  void run(async () => {
                    const { sessionId } = login;
                    const input = { sessionId, code };
                    const added = await callOp(pool.loginComplete, input);
                    setLogin(null);
                    setConnected(added.label);
                  })
                }
              >
                Complete
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default plugin((bb) => {
  bb.slots.settingsSection({ id: "accounts", component: AccountPoolSettings });
});
