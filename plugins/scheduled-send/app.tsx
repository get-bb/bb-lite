import { useEffect, useState, useSyncExternalStore } from "react";
import {
  composer as composerSlots,
  type ComposerContext,
  type ComposerHandle,
  type PluginAppApi,
} from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Input } from "@bb/shared-ui/input";
import { Label } from "@bb/shared-ui/label";
import {
  DEFAULT_SCHEDULE_PRESET_ID,
  defaultCustomSchedule,
  formatScheduleTime,
  formatScheduleTimeZone,
  listSchedulePresets,
  parseCustomScheduleTime,
  type ScheduleTimeParse,
} from "./schedule-time.js";

const CUSTOM = "custom";
const listeners = new Set<() => void>();
let openKey: string | null = null;

function setOpenKey(key: string | null): void {
  openKey = key;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function canSchedule(context: ComposerContext): boolean {
  const handle = context.composer;
  return handle !== null && !handle.isEmpty && !handle.isSubmittingBlocked;
}

function resolve(
  option: string,
  custom: { date: string; time: string },
  now: number,
): ScheduleTimeParse {
  if (option === CUSTOM) return parseCustomScheduleTime(custom, now);
  const preset = listSchedulePresets(now).find((item) => item.id === option);
  return preset === undefined
    ? { ok: false, message: "That option has passed. Choose another time." }
    : { ok: true, at: preset.at };
}

function SendLaterPicker({ composer }: { composer: ComposerHandle }) {
  const open = useSyncExternalStore(subscribe, () => openKey === composer.key);
  const [option, setOption] = useState<string>(DEFAULT_SCHEDULE_PRESET_ID);
  const [custom, setCustom] = useState(() => defaultCustomSchedule(Date.now()));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open && composer.isEmpty) setOpenKey(null);
  }, [open, composer.isEmpty]);
  if (!open) return null;
  const busy = composer.isSubmittingBlocked;
  const now = Date.now();
  const preview = resolve(option, custom, now);
  const schedule = () => {
    const resolved = resolve(option, custom, Date.now());
    if (!resolved.ok) return setError(resolved.message);
    setError(null);
    composer.submit({ sendAt: resolved.at });
    setOpenKey(null);
  };
  return (
    <Dialog open onOpenChange={(next) => !next && setOpenKey(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send later</DialogTitle>
          <DialogDescription>
            Choose when this message should send.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            schedule();
          }}
        >
          <Label htmlFor="scheduled-send-when">When</Label>
          <select
            id="scheduled-send-when"
            aria-label="When to send"
            className="h-9 rounded-md border bg-transparent px-2 text-sm"
            value={option}
            onChange={(event) => setOption(event.target.value)}
          >
            {listSchedulePresets(now).map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
            <option value={CUSTOM}>Custom…</option>
          </select>
          {option === CUSTOM && (
            <div className="flex gap-2">
              <Input
                aria-label="Date"
                type="date"
                value={custom.date}
                onChange={(event) =>
                  setCustom({ ...custom, date: event.target.value })
                }
              />
              <Input
                aria-label="Time"
                type="time"
                value={custom.time}
                onChange={(event) =>
                  setCustom({ ...custom, time: event.target.value })
                }
              />
            </div>
          )}
          <p className="text-muted-foreground text-sm">
            {preview.ok
              ? `Sends ${formatScheduleTime(preview.at, now)} (${formatScheduleTimeZone(preview.at)})`
              : null}
          </p>
          {(error ?? (preview.ok ? null : preview.message)) && (
            <p className="text-destructive text-sm" role="alert">
              {error ?? (preview.ok ? null : preview.message)}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              disabled={busy}
              onClick={() => setOpenKey(null)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={busy || !preview.ok} type="submit">
              {busy ? "Scheduling…" : "Schedule send"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function scheduledSendApp(bb: PluginAppApi): void {
  bb.add(composerSlots.sendMenuItem, {
    id: "send-later",
    label: "Send later…",
    icon: "Calendar",
    isAvailable: canSchedule,
    run: ({ composer }) => setOpenKey(composer?.key ?? null),
  });
  bb.add(composerSlots.banner, { id: "send-later", view: SendLaterPicker });
}
