import { Button } from "@bb/shared-ui/button";
import { CONTEXT_CARD_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { cn } from "@bb/shared-ui/lib/utils";
import { Skeleton } from "@bb/shared-ui/skeleton";
import {
  composer,
  Icon,
  sidePanel,
  threadView,
  useBbNavigate,
  useCall,
  useOp,
  type ComposerHandle,
  type MessageDirectiveProps,
  type PluginAppApi,
  type SidePanelPanelProps,
} from "@bb/plugin/app";
import { z } from "zod";
import {
  workflows,
  type RunStatus,
  type WorkflowCall,
  type WorkflowRun,
} from "./contract";

const PANEL_ID = "workflow-run";
const ACTIVE: readonly RunStatus[] = ["queued", "running"];
const STATUS_TONE: Record<string, string> = {
  queued: "text-muted-foreground",
  running: "text-primary",
  succeeded: "text-emerald-600 dark:text-emerald-400",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
};

function StatusLabel({ status }: { status: string }) {
  return (
    <span className={cn("text-xs font-medium", STATUS_TONE[status])}>
      {status}
    </span>
  );
}

function summary(run: WorkflowRun): string {
  const counts = Object.entries(run.calls)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`);
  return counts.length === 0 ? "No agent calls yet" : counts.join(", ");
}

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

function useOpenRun() {
  const navigate = useBbNavigate();
  return (run: WorkflowRun) =>
    navigate.openThreadPanel({
      actionId: PANEL_ID,
      title: run.name,
      params: { runId: run.id },
    });
}

function RunHeader({ run, onOpen }: { run: WorkflowRun; onOpen?(): void }) {
  const stop = useCall(workflows.stop);
  return (
    <div className="flex items-center gap-2">
      <Icon name="Workflow" className="size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{run.name}</span>
          <StatusLabel status={run.status} />
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {run.phase ? `${run.phase} · ` : ""}
          {summary(run)}
        </div>
      </div>
      {ACTIVE.includes(run.status) ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void stop({ runId: run.id })}
        >
          Stop
        </Button>
      ) : null}
      {onOpen ? (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Open workflow ${run.name} in side panel`}
          onClick={onOpen}
        >
          <Icon name="ArrowRight" className="size-3.5" aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}

function CallRow({ call }: { call: WorkflowCall }) {
  return (
    <li className="flex items-center gap-2 text-xs">
      <span className="w-6 shrink-0 text-right text-muted-foreground">
        {call.index + 1}
      </span>
      <span className="min-w-0 flex-1 truncate">{call.label}</span>
      {call.cached ? (
        <span className="text-muted-foreground">cached</span>
      ) : null}
      <StatusLabel status={call.status} />
    </li>
  );
}

function RunOutcome({ run }: { run: WorkflowRun }) {
  if (run.error) {
    return <p className="text-xs text-destructive">{run.error}</p>;
  }
  if (run.status !== "succeeded") return null;
  return (
    <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
      {preview(run.result)}
    </pre>
  );
}

function RunDetail({ runId, onOpen }: { runId: string; onOpen?(): void }) {
  const query = useOp(workflows.history, { runId, limit: 100 });
  if (query.status === "loading") return <Skeleton className="h-16" />;
  if (query.data === undefined) {
    return (
      <p className="text-xs text-muted-foreground">
        Workflow run {runId} is unavailable.
      </p>
    );
  }
  const { run, calls } = query.data;
  return (
    <div className="flex flex-col gap-2">
      <RunHeader run={run} onOpen={onOpen} />
      {calls.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {calls.map((call) => (
            <CallRow key={call.index} call={call} />
          ))}
        </ul>
      ) : null}
      <RunOutcome run={run} />
    </div>
  );
}

function WorkflowPreview({ attributes }: MessageDirectiveProps) {
  const runId = attributes.run?.trim() ?? "";
  const navigate = useBbNavigate();
  if (runId === "") return null;
  return (
    <div className={cn(CONTEXT_CARD_CLASS, "my-2 p-3")}>
      <RunDetail
        runId={runId}
        onOpen={() =>
          navigate.openThreadPanel({
            actionId: PANEL_ID,
            params: { runId },
          })
        }
      />
    </div>
  );
}

const panelParams = z.object({ runId: z.string().min(1) });

function WorkflowRunPanel({ params }: SidePanelPanelProps) {
  const parsed = panelParams.safeParse(params);
  if (!parsed.success) {
    return (
      <p className="text-sm text-muted-foreground">
        This workflow panel has invalid run parameters.
      </p>
    );
  }
  return <RunDetail runId={parsed.data.runId} />;
}

function ActiveRuns({ threadId }: { threadId: string }) {
  const query = useOp(workflows.list, { threadId });
  const open = useOpenRun();
  const runs = (query.data ?? []).filter((run) => ACTIVE.includes(run.status));
  if (runs.length === 0) return null;
  return (
    <section aria-label="Active workflows" className="flex flex-col gap-1">
      {runs.map((run) => (
        <div key={run.id} className={cn(CONTEXT_CARD_CLASS, "px-3 py-2")}>
          <RunHeader run={run} onOpen={() => open(run)} />
        </div>
      ))}
    </section>
  );
}

function WorkflowBanner({ composer }: { composer: ComposerHandle }) {
  return composer.threadId ? <ActiveRuns threadId={composer.threadId} /> : null;
}

export default function workflowsApp(bb: PluginAppApi) {
  bb.add(threadView.messageDirective, {
    id: "workflow-preview",
    view: WorkflowPreview,
  });
  bb.add(sidePanel.panel, {
    id: PANEL_ID,
    title: "Workflow",
    icon: "Workflow",
    view: WorkflowRunPanel,
  });
  bb.add(composer.banner, {
    id: "active-workflows",
    isAvailable: (handle) => handle.threadId !== null,
    view: WorkflowBanner,
  });
}
