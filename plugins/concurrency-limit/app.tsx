import { useEffect, useState } from "react";
import { callOp, settings, useOp, type PluginAppApi } from "@bb/plugin/app";
import { Input } from "@bb/shared-ui/input";
import {
  concurrencyLimit,
  MAX_LIMIT_VALUE,
  parseLimitValue,
  type Configuration,
  type HostLimit,
} from "./contract.js";

type Status = "saved" | "saving" | "invalid" | { error: string };

function processors(host: HostLimit): string {
  const count = host.availableParallelism;
  if (host.status === "disconnected") {
    return count === null ? "Offline" : `${count} processors · Offline`;
  }
  return count === null ? "Detecting processors…" : `${count} processors`;
}

function LimitInput(props: {
  label: string;
  placeholder: string;
  value: number | null;
  disabled: boolean;
  commit(value: number | null): void;
  invalid(): void;
}) {
  const shown = props.value === null ? "" : String(props.value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const blur = () => {
    const trimmed = draft.trim();
    const value = trimmed === "" ? null : parseLimitValue(trimmed);
    if (trimmed !== "" && value === null) return props.invalid();
    if (value !== props.value) props.commit(value);
  };
  return (
    <Input
      aria-label={props.label}
      className="w-28 shrink-0"
      disabled={props.disabled}
      inputMode="numeric"
      max={MAX_LIMIT_VALUE}
      min={0}
      placeholder={props.placeholder}
      step={1}
      type="number"
      value={draft}
      onBlur={blur}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

function ConcurrencyLimitSettings() {
  const limits = useOp(concurrencyLimit.get, {});
  const [status, setStatus] = useState<Status>("saved");
  const view = limits.data;
  if (view === undefined) {
    const failed = limits.error?.message;
    return (
      <p className={failed ? "text-sm text-destructive" : "text-sm"}>
        {failed ?? "Loading limits…"}
      </p>
    );
  }
  const save = (next: Configuration) => {
    setStatus("saving");
    callOp(concurrencyLimit.update, next).then(
      () => {
        setStatus("saved");
        limits.refetch();
      },
      (error: unknown) =>
        setStatus({
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  };
  const setHost = (hostId: string, limit: number | null) => {
    const hostOverrides = view.hostOverrides.filter(
      (entry) => entry.hostId !== hostId,
    );
    if (limit !== null) hostOverrides.push({ hostId, limit });
    save({ globalLimit: view.globalLimit, hostOverrides });
  };
  const invalid = () => setStatus("invalid");
  const disabled = status === "saving";
  const message =
    status === "invalid"
      ? `Use a whole number from 0 to ${MAX_LIMIT_VALUE}, or leave blank.`
      : typeof status === "object"
        ? status.error
        : status === "saving"
          ? "Saving…"
          : "Saved";
  const failed = status === "invalid" || typeof status === "object";
  return (
    <div className="w-full space-y-5">
      <div className="flex items-start justify-between gap-6 pr-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">Overall limit</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Leave blank for no overall limit. Use 0 to pause new work.
          </p>
        </div>
        <LimitInput
          label="Overall thread limit"
          placeholder="Unlimited"
          value={view.globalLimit}
          disabled={disabled}
          invalid={invalid}
          commit={(globalLimit) =>
            save({ globalLimit, hostOverrides: view.hostOverrides })
          }
        />
      </div>
      <div className="border-t border-border/60 pt-4">
        <h3 className="text-sm font-medium text-foreground">Host limits</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Auto allows one thread per available processor.
        </p>
        <div className="ml-2 mt-2 space-y-1 border-l border-border/60 pl-2">
          {view.hosts.length === 0 && (
            <p className="px-2 py-2 text-sm text-muted-foreground">
              No hosts available.
            </p>
          )}
          {view.hosts.map((host) => (
            <div
              key={host.id}
              className="flex min-h-14 items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/50"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {host.name}
                </div>
                <div className="text-xs text-muted-foreground">
                  {processors(host)}
                </div>
              </div>
              <LimitInput
                label={`${host.name} thread limit`}
                placeholder={`Auto (${host.automaticLimit})`}
                value={host.override}
                disabled={disabled}
                invalid={invalid}
                commit={(limit) => setHost(host.id, limit)}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="flex min-h-5 justify-end" aria-live="polite">
        <span
          className={
            failed
              ? "text-xs text-destructive"
              : "text-xs text-muted-foreground"
          }
          role={failed ? "alert" : "status"}
        >
          {message}
        </span>
      </div>
    </div>
  );
}

export default function concurrencyLimitApp(bb: PluginAppApi): void {
  bb.add(settings.section, {
    id: "configuration",
    view: ConcurrencyLimitSettings,
  });
}
