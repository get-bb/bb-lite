import { useState, type ReactNode } from "react";
import {
  app,
  Icon,
  machines,
  shell,
  useBbNavigate,
  useCall,
  useOp,
  type PluginAppApi,
} from "@bb/plugin/app";
import { appToast } from "@bb/app-kit/components/ui/app-toast";
import { Button } from "@bb/shared-ui/button";
import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "@bb/shared-ui/confirm-delete-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bb/shared-ui/select";
import { Switch } from "@bb/shared-ui/switch";
import DatabaseRestoreIcon from "@hugeicons/core-free-icons/DatabaseRestoreIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import { storageRetention, type Policy, type Usage } from "./contract.js";

const PANEL = "storage-retention";
const ARCHIVE_PRESETS = [7, 14, 30, 60, 90, 180, 365];
const DELETE_PRESETS = [7, 30, 90, 180, 365];
const LARGEST = 5;
const LARGEST_MAX = 20;

interface Feedback {
  title: string;
  description: string;
  failed: string;
}

interface Pending extends Feedback {
  key: string;
  warning: string;
  work: () => Promise<string>;
}

function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function useActions() {
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const run = async (
    key: string,
    feedback: Feedback,
    work: () => Promise<string>,
  ) => {
    if (running.has(key)) return;
    setRunning((current) => new Set(current).add(key));
    const id = appToast.loading(feedback.title, {
      description: feedback.description,
    });
    try {
      appToast.success(await work(), { id, description: feedback.description });
    } catch (error) {
      appToast.error(feedback.failed, {
        id,
        description: `${feedback.description} · ${message(error)}`,
      });
    } finally {
      setRunning((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };
  return { running, run };
}

function Section(props: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">{props.title}</h2>
          {props.description && (
            <p className="text-xs text-muted-foreground">{props.description}</p>
          )}
        </div>
        {props.action}
      </div>
      <div className="divide-y divide-border rounded-lg border border-border bg-card">
        {props.children}
      </div>
    </section>
  );
}

function Row(props: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{props.title}</div>
        {props.description && (
          <div className="text-xs text-muted-foreground">
            {props.description}
          </div>
        )}
      </div>
      {props.children}
    </div>
  );
}

function DaysSelect(props: {
  label: string;
  presets: readonly number[];
  value: number | null;
  disabled: boolean;
  onChange: (value: number | null) => void;
}) {
  const options = [...new Set([...props.presets, props.value ?? 0])]
    .filter((days) => days > 0)
    .sort((a, b) => a - b);
  const label = (days: number | null) =>
    days === null ? "Never" : plural(days, "day");
  return (
    <Select
      value={props.value === null ? "never" : String(props.value)}
      onValueChange={(next) =>
        !props.disabled && props.onChange(next === "never" ? null : +next)
      }
    >
      <SelectTrigger aria-label={props.label} className="w-32">
        <SelectValue>{label(props.value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="never">Never</SelectItem>
        {options.map((days) => (
          <SelectItem key={days} value={String(days)}>
            {label(days)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Retention() {
  const state = useOp(storageRetention.state, {});
  const configure = useCall(storageRetention.configure);
  const runNow = useCall(storageRetention.run);
  const [saving, setSaving] = useState<Policy | null>(null);
  const policy = saving ?? state.data?.policy;
  const preview = useOp(
    storageRetention.preview,
    policy ?? {
      archiveAfterDays: null,
      deleteAfterDays: null,
    },
    { enabled: policy !== undefined },
  );
  const { running, run } = useActions();
  if (policy === undefined) return null;
  const save = async (next: Policy) => {
    if (saving !== null) return;
    setSaving(next);
    try {
      await configure(next);
    } catch (error) {
      appToast.error("Couldn’t save setting", { description: message(error) });
    } finally {
      setSaving(null);
      state.refetch();
    }
  };
  const on =
    policy.archiveAfterDays !== null || policy.deleteAfterDays !== null;
  const lastRun = state.data?.lastRun;
  return (
    <Section
      title="Automatic retention"
      description="Archive or delete inactive threads across all projects. Pinned threads are never archived or deleted. Changes save automatically."
      action={
        on && (
          <Button
            size="sm"
            variant="outline"
            disabled={running.has("run")}
            onClick={() =>
              void run(
                "run",
                {
                  title: "Running retention",
                  description: "All projects",
                  failed: "Retention run failed",
                },
                async () => {
                  const result = await runNow({});
                  state.refetch();
                  return result === null
                    ? "Retention is already running"
                    : `Archived ${result.archivedCount}, deleted ${result.deletedCount}`;
                },
              )
            }
          >
            Run now
          </Button>
        )
      }
    >
      <Row
        title="Archive inactive threads"
        description="After this long with no activity."
      >
        <DaysSelect
          label="Archive inactive threads"
          presets={ARCHIVE_PRESETS}
          value={policy.archiveAfterDays}
          disabled={saving !== null}
          onChange={(value) =>
            void save({ ...policy, archiveAfterDays: value })
          }
        />
      </Row>
      <Row
        title="Delete archived threads"
        description="Permanently, after this long in the archive."
      >
        <DaysSelect
          label="Delete archived threads"
          presets={DELETE_PRESETS}
          value={policy.deleteAfterDays}
          disabled={saving !== null}
          onChange={(value) => void save({ ...policy, deleteAfterDays: value })}
        />
      </Row>
      <Row
        title="Delete thread storage on archive"
        description="Permanently remove files after archiving. Conversations and uploaded attachments are kept. Pinned threads are skipped."
      >
        <Switch
          aria-label="Delete thread storage on archive"
          checked={policy.deleteStorageOnArchive}
          disabled={saving !== null}
          onCheckedChange={(checked) =>
            void save({ ...policy, deleteStorageOnArchive: checked })
          }
        />
      </Row>
      <Row
        title={on ? "Checks hourly" : "Off"}
        description={[
          on && preview.data
            ? `Next check: archive ${plural(preview.data.archiveCount, "thread")}, delete ${plural(preview.data.deleteCount, "thread")}.`
            : null,
          lastRun
            ? `Last run ${new Date(lastRun.ranAt).toLocaleString()}: archived ${lastRun.archivedCount}, deleted ${lastRun.deletedCount}, failed ${lastRun.failedCount}.`
            : null,
        ]
          .filter(Boolean)
          .join(" ")}
      />
    </Section>
  );
}

function DiskBar({ report }: { report: Usage }) {
  if (report.disk === null || report.disk.totalBytes === 0) return null;
  const { totalBytes, freeBytes } = report.disk;
  const used = Math.min(100, ((totalBytes - freeBytes) / totalBytes) * 100);
  return (
    <div className="space-y-1 px-4 py-3">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-foreground" style={{ width: `${used}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">
        {formatBytes(freeBytes)} free of {formatBytes(totalBytes)}
      </p>
    </div>
  );
}

function MachinePage({ report }: { report: Usage }) {
  const navigate = useBbNavigate();
  const clearThread = useCall(storageRetention.clearThread);
  const clearArchived = useCall(storageRetention.clearArchivedFiles);
  const clearLarge = useCall(storageRetention.clearLargeFiles);
  const removeOrphans = useCall(storageRetention.removeOrphans);
  const retry = useCall(storageRetention.retryWorktreeCleanup);
  const { running, run } = useActions();
  const [shown, setShown] = useState(LARGEST);
  const [pending, setPending] = useState<Pending | null>(null);
  const hostId = report.hostId;
  const largest = [...report.threads]
    .filter((thread) => thread.sizeBytes > 0)
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
  const archivedBytes = report.threads
    .filter((thread) => thread.clearable)
    .reduce((sum, thread) => sum + thread.sizeBytes, 0);
  const orphanBytes = report.orphans.reduce(
    (sum, entry) => sum + entry.sizeBytes,
    0,
  );
  const action = (label: string, next: Pending) => (
    <Button
      size="sm"
      variant="outline"
      disabled={running.has(next.key)}
      onClick={() => setPending(next)}
    >
      {label}
    </Button>
  );
  const confirm = (chosen: Pending) => {
    setPending(null);
    void run(chosen.key, chosen, chosen.work);
  };
  const cleanup = (key: string, label: string, work: () => Promise<string>) =>
    action(label, {
      key,
      title: label,
      description: report.name,
      failed: `${label} failed`,
      warning: "This permanently deletes files on this machine.",
      work,
    });
  return (
    <div className="space-y-6">
      <Section title="Clean up">
        <Row
          title="All files in archived threads"
          description={`${formatBytes(archivedBytes)} in archived, stopped, unpinned threads`}
        >
          {cleanup("archived", "Clear files", async () => {
            const result = await clearArchived({ hostId });
            return `Cleared ${plural(result.clearedThreads, "thread")} (${formatBytes(result.clearedBytes)})`;
          })}
        </Row>
        <Row
          title="Large files in archived threads"
          description="Files of 10 MB or more"
        >
          {cleanup("large", "Delete large files", async () => {
            const result = await clearLarge({ hostId });
            return `Deleted ${plural(result.clearedFiles, "file")} (${formatBytes(result.clearedBytes)})`;
          })}
        </Row>
        <Row
          title="Orphaned storage"
          description={`${plural(report.orphans.length, "folder")} without a thread, ${formatBytes(orphanBytes)}`}
        >
          {report.orphans.length > 0 &&
            cleanup("orphans", "Remove orphans", async () => {
              const result = await removeOrphans({ hostId });
              return `Removed ${plural(result.removedCount, "folder")} (${formatBytes(result.removedBytes)})`;
            })}
        </Row>
        <Row
          title="Leftover worktrees"
          description="Retry cleanup of worktrees whose removal failed or is overdue"
        >
          <Button
            size="sm"
            variant="outline"
            disabled={running.has("worktrees")}
            onClick={() =>
              void run(
                "worktrees",
                {
                  title: "Retrying worktree cleanup",
                  description: report.name,
                  failed: "Worktree cleanup failed",
                },
                async () =>
                  `Retried ${plural((await retry({ hostId })).retriedCount, "worktree")}`,
              )
            }
          >
            Retry
          </Button>
        </Row>
      </Section>
      <Section title="Threads using the most storage">
        {largest.length === 0 && <Row title="No thread storage" />}
        {largest.slice(0, shown).map((thread) => (
          <Row
            key={thread.threadId}
            title={
              <button
                type="button"
                className="truncate hover:underline"
                onClick={() => navigate.toThread(thread.threadId)}
              >
                {thread.title ?? thread.threadId}
              </button>
            }
            description={`${formatBytes(thread.sizeBytes)}${thread.archived ? " · Archived" : ""}`}
          >
            {thread.clearable &&
              action("Clear", {
                key: thread.threadId,
                title: "Clear thread files",
                description: thread.title ?? thread.threadId,
                failed: "Couldn’t clear thread files",
                warning:
                  "This permanently deletes the thread's files. The conversation is kept.",
                work: async () => {
                  await clearThread({ threadId: thread.threadId });
                  return "Cleared thread files";
                },
              })}
          </Row>
        ))}
        {largest.length > shown && shown < LARGEST_MAX && (
          <Row title="">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShown(LARGEST_MAX)}
            >
              Show more
            </Button>
          </Row>
        )}
      </Section>
      <ConfirmDeleteDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
      >
        {pending && (
          <ConfirmDeleteDialogContent
            title={`${pending.title}?`}
            description={`${pending.description}. ${pending.warning}`}
            confirmLabel={pending.title}
            pending={false}
            onConfirm={() => confirm(pending)}
            onCancel={() => setPending(null)}
          />
        )}
      </ConfirmDeleteDialog>
    </div>
  );
}

function StoragePanel() {
  const hosts = useOp(machines.list, {});
  const usage = useOp(storageRetention.usage, {});
  const scan = useCall(storageRetention.scan);
  const { running, run } = useActions();
  const [open, setOpen] = useState<string | null>(null);
  const reports = new Map(
    (usage.data ?? []).map((report) => [report.hostId, report]),
  );
  const rescan = (hostId: string | undefined, name: string) =>
    void run(
      hostId ?? "all",
      {
        title: "Scanning storage",
        description: name,
        failed: "Scan failed",
      },
      async () => {
        const scanned = await scan(hostId === undefined ? {} : { hostId });
        return `Scanned ${plural(scanned.length, "machine")}`;
      },
    );
  const selected = open === null ? undefined : reports.get(open);
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 overflow-y-auto p-6">
      <h1 className="flex items-center gap-2 text-lg font-semibold">
        <Icon name="DatabaseRestore" className="size-5" />
        Storage & retention
      </h1>
      {selected ? (
        <>
          <Section
            title={selected.name}
            description={`${formatBytes(selected.threadStorageBytes)} of thread storage in ${selected.rootPath} · scanned ${new Date(selected.scannedAt).toLocaleString()}`}
            action={
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
                  Back
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={running.has(selected.hostId)}
                  onClick={() => rescan(selected.hostId, selected.name)}
                >
                  Rescan
                </Button>
              </div>
            }
          >
            <DiskBar report={selected} />
          </Section>
          <MachinePage report={selected} />
        </>
      ) : (
        <>
          <Section
            title="Machine storage"
            action={
              <Button
                size="sm"
                variant="outline"
                disabled={running.has("all")}
                onClick={() => rescan(undefined, "All online machines")}
              >
                Rescan
              </Button>
            }
          >
            {(hosts.data ?? []).map((host) => {
              const report = reports.get(host.id);
              return (
                <div key={host.id}>
                  <Row
                    title={host.name}
                    description={
                      report
                        ? `${formatBytes(report.threadStorageBytes)} thread storage · ${plural(report.orphans.length, "orphan")}`
                        : host.status === "connected"
                          ? "Not scanned yet"
                          : "Offline"
                    }
                  >
                    {report ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setOpen(host.id)}
                      >
                        Open
                      </Button>
                    ) : (
                      host.status === "connected" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={running.has(host.id)}
                          onClick={() => rescan(host.id, host.name)}
                        >
                          Scan
                        </Button>
                      )
                    )}
                  </Row>
                  {report && <DiskBar report={report} />}
                </div>
              );
            })}
          </Section>
          <Retention />
        </>
      )}
    </div>
  );
}

function DatabaseRestore({ className }: { className?: string }) {
  return <HugeiconsIcon icon={DatabaseRestoreIcon} className={className} />;
}

export default function storageRetentionApp(bb: PluginAppApi): void {
  bb.add(app.icon, { name: "DatabaseRestore", view: DatabaseRestore });
  bb.add(shell.navPanel, {
    id: PANEL,
    title: "Storage & retention",
    icon: "DatabaseRestore",
    path: PANEL,
    view: StoragePanel,
  });
}
