import { useCallback, useEffect, useState } from "react";
import { definePluginApp, UrlLink, useRealtime, useRpc } from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { Switch } from "@bb/shared-ui/switch";
import type { ConnectStatus, connectRpcContract } from "./src/contract.js";

const DOT_CLASS = {
  ok: "bg-success shadow-[0_0_0_3px_color-mix(in_oklab,var(--success)_18%,transparent)]",
  warn: "animate-pulse bg-warning shadow-[0_0_0_3px_color-mix(in_oklab,var(--warning)_22%,transparent)]",
  muted: "bg-muted-foreground/50",
};
const DANGER_QUIET_CLASS =
  "text-destructive-text hover:text-destructive-text hover:bg-surface-destructive";
const URL_HERO_CLASS =
  "flex max-w-xl items-center gap-1 rounded-lg border border-border bg-surface-recessed py-1 pl-3.5 pr-1";
const URL_CLASS =
  "min-w-0 flex-1 truncate font-mono text-sm font-medium text-foreground no-underline hover:underline";
const SHARES_TITLE_CLASS =
  "text-2xs font-semibold uppercase tracking-wide text-subtle-foreground";
const SHARE_PORT_CLASS =
  "shrink-0 font-mono text-xs tabular-nums text-foreground";
const SHARE_URL_CLASS =
  "min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground underline-offset-2 hover:underline";
const FOOTER_CLASS =
  "-mx-4 mt-4 flex items-center gap-3 border-t border-border-seam px-4 pt-3";
const PENDING_CLASS =
  "space-y-2.5 rounded-md border border-border bg-surface-recessed/50 px-3 py-3";
const WAITING_CLASS = "flex items-center gap-2 text-xs text-subtle-foreground";
const NEW_TAB = { target: "_blank", rel: "noreferrer" };
const QUIET = { type: "button", variant: "ghost", size: "sm" } as const;

function ConnectSettingsSection() {
  const rpc = useRpc<typeof connectRpcContract>();
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const show = useCallback(async (work: Promise<ConnectStatus>) => {
    try {
      setStatus(await work);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);
  const refresh = useCallback(() => {
    void show(rpc.call("status"));
  }, [rpc, show]);
  useEffect(refresh, [refresh]);
  useRealtime("status", refresh);
  const act = (work: Promise<ConnectStatus>) => {
    setBusy(true);
    void show(work).finally(() => setBusy(false));
  };

  if (status === null) {
    const tone = error ? "text-destructive-text" : "text-muted-foreground";
    return <p className={`text-sm ${tone}`}>{error ?? "Loading..."}</p>;
  }
  const { login, url } = status;
  const live = status.state === "connected";
  const tone = !status.enabled ? "muted" : live ? "ok" : "warn";
  const title = live ? "Connected" : "Reconnecting…";
  const failed = login?.state === "failed" ? login.message : null;
  const signedIn = (
    <>
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[tone])}
        />
        <span className="shrink-0 text-sm font-semibold">
          {status.enabled ? title : "Remote access is off"}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {status.enabled ? status.lastError : null}
        </span>
        <Switch
          aria-label="Remote access"
          checked={status.enabled}
          disabled={busy}
          onCheckedChange={(enabled) =>
            act(rpc.call("setEnabled", { enabled }))
          }
        />
      </div>
      <div className={URL_HERO_CLASS}>
        <UrlLink href={url ?? ""} {...NEW_TAB} className={URL_CLASS}>
          {url}
        </UrlLink>
      </div>
      {status.shares.length > 0 ? (
        <div className="space-y-2.5 border-t border-border-seam pt-4">
          <h3 className={SHARES_TITLE_CLASS}>Shared ports</h3>
          <ul className="space-y-1">
            {status.shares.map(({ port, url: shareUrl }) => (
              <li key={port} className="flex items-center gap-2">
                <span className={SHARE_PORT_CLASS}>:{port}</span>
                <UrlLink
                  href={shareUrl ?? ""}
                  {...NEW_TAB}
                  className={SHARE_URL_CLASS}
                >
                  {shareUrl?.replace(/^https?:\/\//u, "")}
                </UrlLink>
                <Button
                  {...QUIET}
                  className={DANGER_QUIET_CLASS}
                  disabled={busy}
                  onClick={() => act(rpc.call("unexpose", { port }))}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className={FOOTER_CLASS}>
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">
          Signed in as {status.handle}. Turning remote access off keeps this bb
          signed in.
        </span>
        <Button
          {...QUIET}
          className={DANGER_QUIET_CLASS}
          disabled={busy}
          onClick={() => act(rpc.call("logout"))}
        >
          Sign out
        </Button>
      </div>
    </>
  );
  const pending = login?.state === "pending" && (
    <div className={PENDING_CLASS}>
      <p className="text-xs text-muted-foreground">
        Confirm this code on {new URL(login.verificationUrl).host}:
      </p>
      <p
        aria-label="Sign-in code"
        className="font-mono text-base font-semibold tracking-widest"
      >
        {login.userCode}
      </p>
      <Button type="button" asChild>
        <UrlLink href={login.verificationUrl} {...NEW_TAB}>
          Open getbb.dev
          <Icon name="ExternalLink" className="size-3.5" />
        </UrlLink>
      </Button>
      <p className={WAITING_CLASS}>
        <Icon name="Spinner" className="size-3.5 animate-spin" />
        Waiting for you to approve it. You can approve from any device.
      </p>
    </div>
  );
  const signedOut = (
    <>
      <p className="text-sm text-muted-foreground">
        Remote access uses your bb account. Once you sign in, this bb gets a
        private getbb.dev URL for your browsers and machines. Your code and data
        stay on this machine.
      </p>
      {failed && <p className="text-xs text-destructive-text">{failed}</p>}
      <Button
        type="button"
        className="h-auto min-h-9 max-w-full whitespace-normal"
        disabled={busy}
        onClick={() => act(rpc.call("login"))}
      >
        {failed === null ? "Sign in to your bb account" : "Try again"}
      </Button>
    </>
  );

  return (
    <div className="space-y-4">
      {status.paired ? signedIn : pending || signedOut}
      {error && <p className="text-xs text-destructive-text">{error}</p>}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "remote-access",
    description:
      "Use this bb from any device, anywhere — powered by getbb.dev.",
    component: ConnectSettingsSection,
  });
});
