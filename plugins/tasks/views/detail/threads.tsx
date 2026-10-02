import { useState } from "react";
import { toast } from "sonner";
import { useBbNavigate } from "@bb/plugin/app";
import type { LiveStatus, Preset, TaskThread } from "../../shared/contract.js";
import { reportError, useTasksRpc } from "../../shell/data.js";
import { ConfirmDialog } from "../../components/common.js";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { formatRelativeTime } from "./activity.js";

const THREAD_STATUS_META: Record<
  LiveStatus,
  [label: string, dotClassName: string, textClassName: string]
> = {
  starting: ["Starting", "bg-attention animate-pulse", "text-attention"],
  working: ["Working", "bg-success animate-pulse", "text-success"],
  idle: ["Idle", "bg-muted-foreground", "text-muted-foreground"],
  completed: ["Completed", "bg-muted", "text-muted-foreground"],
  failed: ["Failed", "bg-destructive", "text-destructive"],
};
const LAST_PRESET_STORAGE_KEY = "bb-tasks:last-dispatch-preset";
const NO_PRESET_HINT =
  "No dispatch presets yet. Create one with: bb tasks preset set <name> --provider … --model … --reasoning … --permission …";
const PRIMARY_SEGMENT =
  "bg-primary text-primary-foreground hover:bg-primary/90";

export function isActiveThread(thread: TaskThread): boolean {
  return thread.liveStatus === "starting" || thread.liveStatus === "working";
}

function readLastPresetId(): string | null {
  try {
    return window.localStorage.getItem(LAST_PRESET_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function DispatchControl({
  taskId,
  presets,
  align = "end",
  className,
}: {
  taskId: string;
  presets: Preset[] | undefined;
  align?: "start" | "end";
  className?: string;
}) {
  const rpc = useTasksRpc();
  const [dispatching, setDispatching] = useState(false);
  const [lastPresetId, setLastPresetId] = useState(readLastPresetId);

  const pickPreset = (preset: Preset) => {
    setLastPresetId(preset.id);
    try {
      window.localStorage.setItem(LAST_PRESET_STORAGE_KEY, preset.id);
    } catch {}
    setDispatching(true);
    rpc
      .call("dispatch", { taskId, presetId: preset.id })
      .catch(reportError)
      .finally(() => setDispatching(false));
  };

  if (presets?.length === 0) {
    return (
      <Button
        size="sm"
        className={cn("h-7 gap-1.5", PRIMARY_SEGMENT, className)}
        onClick={() => toast.info(NO_PRESET_HINT)}
      >
        <Icon name="Plus" className="size-3.5 shrink-0" />
        Add a preset…
      </Button>
    );
  }
  const current =
    presets?.find((preset) => preset.id === lastPresetId) ??
    [...(presets ?? [])].sort((a, b) => a.name.localeCompare(b.name))[0];

  return (
    <div className={cn("flex min-w-0", className)}>
      <Button
        size="sm"
        disabled={dispatching || !current}
        className={cn(
          "h-7 min-w-0 flex-1 gap-1.5 rounded-r-none",
          PRIMARY_SEGMENT,
        )}
        onClick={() => {
          if (current) pickPreset(current);
        }}
      >
        <span className="truncate">
          {dispatching ? "Dispatching…" : (current?.name ?? "Dispatch")}
        </span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={dispatching || !current}>
          <Button
            size="sm"
            aria-label="Choose dispatch preset"
            className={cn(
              "h-7 shrink-0 rounded-l-none border-l border-primary-foreground/25 px-1",
              PRIMARY_SEGMENT,
            )}
          >
            <Icon name="ChevronDown" className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align}>
          <DropdownMenuLabel>Dispatch with preset</DropdownMenuLabel>
          {(presets ?? []).map((preset) => (
            <DropdownMenuItem
              key={preset.id}
              onSelect={() => pickPreset(preset)}
            >
              <span className="min-w-0 flex-1 truncate">{preset.name}</span>
              <span className="text-xs text-muted-foreground">
                {preset.modelId}
              </span>
              {preset.id === current?.id ? (
                <Icon name="Check" className="size-3.5" />
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function ThreadsSection({
  taskId,
  threads,
}: {
  taskId: string;
  threads: TaskThread[];
}) {
  const rpc = useTasksRpc();
  const navigate = useBbNavigate();
  const [confirm, setConfirm] = useState<TaskThread | null>(null);
  const activeCount = threads.filter(isActiveThread).length;

  return (
    <section>
      <div className="mb-2 flex items-center gap-2 pt-1.5 text-xs font-semibold text-muted-foreground">
        Agent threads
        {activeCount > 0 ? (
          <span className="font-normal">{activeCount} working now</span>
        ) : null}
      </div>
      {threads.map((thread) => {
        const [label, dot, text] = THREAD_STATUS_META[thread.liveStatus];
        return (
          <div
            key={thread.id}
            className="mb-2 flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2 shadow-2xs"
          >
            <span
              className={cn(
                "flex shrink-0 items-center gap-1.5 text-xs font-medium",
                text,
              )}
            >
              <span aria-hidden className={cn("size-1.5 rounded-full", dot)} />
              {label}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{thread.title}</div>
              <div className="text-xs text-muted-foreground">
                {thread.presetName} · attached{" "}
                {formatRelativeTime(thread.attachedAt)}
              </div>
            </div>
            <button
              type="button"
              className="flex shrink-0 items-center gap-1 text-xs font-medium underline decoration-input underline-offset-2 hover:decoration-current"
              onClick={() => navigate.toThread(thread.threadId)}
            >
              Open thread
              <Icon name="ArrowUpRight" className="size-3" />
            </button>
            <button
              type="button"
              aria-label={`Detach ${thread.title}`}
              title="Detach from task"
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-70"
              onClick={() => setConfirm(thread)}
            >
              <Icon name="X" className="size-3" />
            </button>
          </div>
        );
      })}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title="Detach thread?"
        description={
          confirm
            ? `"${confirm.title}" will no longer be listed on this task. The thread itself is not deleted; re-attach it with bb tasks attach.`
            : ""
        }
        confirmLabel="Detach"
        onConfirm={() => {
          if (!confirm) return;
          const { threadId } = confirm;
          rpc.call("detachThread", { taskId, threadId }).catch(reportError);
        }}
      />
    </section>
  );
}
