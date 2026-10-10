import { useRef, useState } from "react";
import { callOp, settings, useOp, type PluginAppApi } from "@bb/plugin/app";
import { Switch } from "@bb/shared-ui/switch";
import {
  keepAwake,
  MAX_SELECTED_HOSTS,
  type HostSelection,
  type KeepAwakeConfiguration,
} from "./contract.js";

const OPTION_CLASS =
  "flex cursor-pointer items-start gap-3 rounded-md px-2 py-2 hover:bg-accent/50";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function KeepAwakeSettings() {
  const loaded = useOp(keepAwake.configuration, {});
  const [draft, setDraft] = useState<KeepAwakeConfiguration | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queue = useRef(Promise.resolve());
  const revision = useRef(0);
  const view = draft ?? loaded.data;

  if (view === undefined) {
    const failed = loaded.error?.message ?? error;
    return (
      <p
        className={`text-sm ${failed ? "text-destructive" : "text-muted-foreground"}`}
        role={failed ? "alert" : "status"}
      >
        {failed ?? "Loading hosts…"}
      </p>
    );
  }

  const update = (next: KeepAwakeConfiguration) => {
    const mine = ++revision.current;
    setDraft(next);
    setSaving(true);
    setError(null);
    const { enabled, selection } = next;
    queue.current = queue.current
      .then(() => callOp(keepAwake.updateConfiguration, { enabled, selection }))
      .then(() => {
        if (revision.current !== mine) return;
        loaded.refetch();
        setDraft(null);
        setSaving(false);
      })
      .catch((failure: unknown) => {
        if (revision.current !== mine) return;
        setDraft(null);
        setSaving(false);
        setError(messageOf(failure));
      });
  };
  const select = (selection: HostSelection) => update({ ...view, selection });
  const chosen =
    view.selection.mode === "selected" ? view.selection.hostIds : [];
  const toggleHost = (hostId: string, on: boolean) => {
    const hostIds = on
      ? [...new Set([...chosen, hostId])]
      : chosen.filter((id) => id !== hostId);
    if (hostIds.length > 0) select({ mode: "selected", hostIds });
  };
  const selectSpecific = () => {
    const hostIds = view.hosts.map(({ id }) => id).slice(0, MAX_SELECTED_HOSTS);
    if (hostIds.length > 0) select({ mode: "selected", hostIds });
  };
  const hasHosts = view.hosts.length > 0;

  return (
    <div className="w-full space-y-5">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">
            Prevent idle sleep
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Keep selected Macs awake while bb is running. Closing the lid or
            choosing Sleep still sleeps the Mac.
          </p>
        </div>
        <Switch
          checked={view.enabled}
          aria-label="Keep Awake"
          onCheckedChange={(enabled) => update({ ...view, enabled })}
        />
      </div>
      {view.enabled && (
        <div className="space-y-3 border-t border-border/60 pt-4">
          <div>
            <h3 className="text-sm font-medium text-foreground">Hosts</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Choose which Macs to keep awake.
            </p>
          </div>
          <label className={OPTION_CLASS}>
            <input
              type="radio"
              className="mt-1"
              checked={view.selection.mode === "all"}
              onChange={() => select({ mode: "all" })}
            />
            <span>
              <span className="block text-sm font-medium">All hosts</span>
              <span className="block text-xs text-muted-foreground">
                Include hosts added in the future. Only macOS and Windows hosts
                are supported.
              </span>
            </span>
          </label>
          <label
            className={hasHosts ? OPTION_CLASS : `${OPTION_CLASS} opacity-50`}
          >
            <input
              type="radio"
              className="mt-1"
              disabled={!hasHosts}
              checked={view.selection.mode === "selected"}
              onChange={() => view.selection.mode === "all" && selectSpecific()}
            />
            <span>
              <span className="block text-sm font-medium">Specific hosts</span>
              <span className="block text-xs text-muted-foreground">
                Choose individual Macs below.
              </span>
            </span>
          </label>
          {view.selection.mode === "selected" && (
            <div className="divide-y divide-border/60 rounded-md border border-border/60">
              {view.hosts.map((host) => {
                const on = chosen.includes(host.id);
                return (
                  <label
                    key={host.id}
                    className="flex min-h-10 items-center gap-3 px-3 py-2"
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={on && chosen.length === 1}
                      aria-label={host.name}
                      onChange={(event) =>
                        toggleHost(host.id, event.target.checked)
                      }
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {host.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {host.status === "connected" ? "Connected" : "Offline"}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}
      <div className="flex min-h-5 justify-end" aria-live="polite">
        {error === null ? (
          <span className="text-xs text-muted-foreground" role="status">
            {saving ? "Saving…" : "Saved"}
          </span>
        ) : (
          <span className="text-xs text-destructive" role="alert">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

export default function keepAwakeApp(bb: PluginAppApi): void {
  bb.add(settings.section, { id: "configuration", view: KeepAwakeSettings });
}
