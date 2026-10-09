import { useState, type ReactNode } from "react";
import {
  projects,
  type ShellNavPanelProps,
  useBbContext,
  useBbNavigate,
  useCall,
  useOp,
} from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { automations, type Automation, type Run } from "../contract.js";
import { AutomationForm } from "./form.js";
import {
  canToggle,
  CREATE_AUTOMATION_PROMPT,
  describeTrigger,
  editAutomationPrompt,
  formatRunTime,
  statusLabel,
} from "./schedule.js";

type Route =
  | { kind: "overview" }
  | { kind: "new" }
  | { kind: "detail" | "edit"; projectId: string; automationId: string };

function parseRoute(subPath: string): Route {
  const [projectId, automationId, extra] = subPath.split("/").filter(Boolean);
  if (projectId === "new" && automationId === undefined) return { kind: "new" };
  if (projectId === undefined || automationId === undefined) {
    return { kind: "overview" };
  }
  return {
    kind: extra === "edit" ? "edit" : "detail",
    projectId,
    automationId,
  };
}

function useGo() {
  const navigate = useBbNavigate();
  return (subPath: string) =>
    navigate.toPluginPanel("automations", { subPath });
}

const pathOf = (automation: Automation) =>
  `${automation.projectId}/${automation.id}`;

function Page({
  title,
  back,
  actions,
  children,
}: {
  title: string;
  back?: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col overflow-auto">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        {back && (
          <Button size="icon" variant="ghost" aria-label="Back" onClick={back}>
            <Icon name="ChevronLeft" />
          </Button>
        )}
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
        {actions}
      </header>
      <div className="grid gap-4 p-4">{children}</div>
    </div>
  );
}

export function AutomationsPanel({ subPath }: ShellNavPanelProps) {
  const route = parseRoute(subPath);
  const go = useGo();
  const { projectId } = useBbContext();
  if (route.kind === "overview") return <Overview />;
  if (route.kind === "new") {
    return (
      <Page title="New automation" back={() => go("")}>
        <AutomationForm
          projectId={projectId}
          onDone={(created) => go(pathOf(created))}
          onCancel={() => go("")}
        />
      </Page>
    );
  }
  return <Detail key={subPath} route={route} />;
}

function Overview() {
  const go = useGo();
  const navigate = useBbNavigate();
  const list = useOp(projects.list, { includePersonal: true });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  return (
    <Page
      title="Automations"
      actions={
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              navigate.toCompose({
                initialPrompt: CREATE_AUTOMATION_PROMPT,
                focusPrompt: true,
              })
            }
          >
            Create with agent
          </Button>
          <Button size="sm" onClick={() => go("new")}>
            <Icon name="Plus" />
            New
          </Button>
        </>
      }
    >
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search automations"
          className="h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-sm"
        />
        <select
          value={filter}
          onChange={(event) => setFilter(filterOf(event.target.value))}
          className="h-8 rounded-md border bg-transparent px-2 text-sm"
        >
          {FILTERS.map((each) => (
            <option key={each} value={each}>
              {each}
            </option>
          ))}
        </select>
      </div>
      {(list.data ?? []).map((project) => (
        <ProjectSection
          key={project.id}
          projectId={project.id}
          name={project.name}
          query={query.trim().toLowerCase()}
          filter={filter}
        />
      ))}
      <p className="text-xs text-muted-foreground">
        Automations start agent threads on a schedule or once at a set time.
      </p>
    </Page>
  );
}

const FILTERS = ["all", "active", "paused", "failing"] as const;
type Filter = (typeof FILTERS)[number];
const filterOf = (value: string): Filter =>
  FILTERS.find((each) => each === value) ?? "all";

function shown(automation: Automation, query: string, filter: Filter) {
  const text = `${automation.name} ${
    automation.execution.mode === "agent"
      ? automation.execution.prompt
      : automation.execution.script
  }`.toLowerCase();
  if (query && !text.includes(query)) return false;
  if (filter === "active") return automation.enabled;
  if (filter === "paused") return !automation.enabled;
  if (filter === "failing") return automation.lastRunStatus === "failed";
  return true;
}

function ProjectSection({
  projectId,
  name,
  query,
  filter,
}: {
  projectId: string;
  name: string;
  query: string;
  filter: Filter;
}) {
  const go = useGo();
  const list = useOp(automations.list, { projectId });
  const items = (list.data ?? []).filter((automation) =>
    shown(automation, query, filter),
  );
  if (items.length === 0) return null;
  return (
    <section className="grid gap-1">
      <h2 className="text-xs font-medium text-muted-foreground">{name}</h2>
      {items.map((automation) => (
        <button
          key={automation.id}
          type="button"
          onClick={() => go(pathOf(automation))}
          className="flex items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover"
        >
          <span className="min-w-0 flex-1 truncate">{automation.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {describeTrigger(automation.trigger)} · {statusLabel(automation)}
          </span>
        </button>
      ))}
    </section>
  );
}

function Detail({
  route,
}: {
  route: { kind: "detail" | "edit"; projectId: string; automationId: string };
}) {
  const go = useGo();
  const navigate = useBbNavigate();
  const ref = { projectId: route.projectId, automationId: route.automationId };
  const found = useOp(automations.get, ref);
  const runs = useOp(automations.runs, ref);
  const pause = useCall(automations.pause);
  const resume = useCall(automations.resume);
  const run = useCall(automations.run);
  const remove = useCall(automations.delete);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const automation = found.data;
  if (automation === undefined) {
    return (
      <Page title="Automation" back={() => go("")}>
        <p className="text-sm text-muted-foreground">
          {found.status === "error" ? "Automation not found." : "Loading…"}
        </p>
      </Page>
    );
  }
  if (route.kind === "edit") {
    return (
      <Page
        title={`Edit ${automation.name}`}
        back={() => go(pathOf(automation))}
      >
        <AutomationForm
          automation={automation}
          projectId={automation.projectId}
          onDone={(saved) => go(pathOf(saved))}
          onCancel={() => go(pathOf(automation))}
        />
      </Page>
    );
  }
  const act = (action: () => Promise<unknown>) => {
    setError(null);
    action().catch((failure: unknown) =>
      setError(failure instanceof Error ? failure.message : String(failure)),
    );
  };
  const { execution, trigger } = automation;
  return (
    <Page
      title={automation.name}
      back={() => go("")}
      actions={
        <>
          {canToggle(automation) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                act(() => (automation.enabled ? pause : resume)(ref))
              }
            >
              {automation.enabled ? "Pause" : "Resume"}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => act(() => run(ref))}>
            Run now
          </Button>
          {execution.mode === "agent" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => go(`${pathOf(automation)}/edit`)}
            >
              Edit
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              navigate.toCompose({
                initialPrompt: editAutomationPrompt(automation),
                focusPrompt: true,
              })
            }
          >
            Edit with agent
          </Button>
          <Button
            size="sm"
            variant={confirming ? "destructive" : "ghost"}
            onClick={() =>
              confirming
                ? act(() => remove(ref).then(() => go("")))
                : setConfirming(true)
            }
          >
            {confirming ? "Confirm delete" : "Delete"}
          </Button>
        </>
      }
    >
      {error && <p className="text-sm text-destructive">{error}</p>}
      <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Schedule</dt>
        <dd>
          {describeTrigger(trigger)}
          {trigger.triggerType === "schedule" && (
            <span className="text-muted-foreground">
              {" "}
              ({trigger.cron}, {trigger.timezone})
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd>{statusLabel(automation)}</dd>
        {execution.mode === "agent" ? (
          <>
            <dt className="text-muted-foreground">Agent</dt>
            <dd>
              {execution.providerId} · {execution.model} ·{" "}
              {execution.reasoningLevel} · {execution.permissionMode}
            </dd>
          </>
        ) : (
          <>
            <dt className="text-muted-foreground">Script</dt>
            <dd>
              {execution.interpreter ?? "bash"}
              {execution.scriptFile && ` · ${execution.scriptFile}`} · timeout{" "}
              {Math.round(execution.timeoutMs / 1000)}s
            </dd>
          </>
        )}
        {execution.mode === "agent" && execution.targetThreadId && (
          <>
            <dt className="text-muted-foreground">Sends to</dt>
            <dd>
              <ThreadLink threadId={execution.targetThreadId} />
            </dd>
          </>
        )}
        {automation.lastError && (
          <>
            <dt className="text-muted-foreground">Last error</dt>
            <dd className="text-destructive">{automation.lastError}</dd>
          </>
        )}
      </dl>
      <pre className="whitespace-pre-wrap rounded-md border p-3 text-sm">
        {execution.mode === "agent" ? execution.prompt : execution.script}
      </pre>
      <section className="grid gap-1">
        <h2 className="text-xs font-medium text-muted-foreground">Runs</h2>
        {runs.data?.runs.length === 0 && (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        )}
        {runs.data?.runs.map((entry) => (
          <RunRow key={entry.id} run={entry} />
        ))}
      </section>
    </Page>
  );
}

function ThreadLink({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  return (
    <button
      type="button"
      className="text-left underline-offset-2 hover:underline"
      onClick={() => navigate.toThread(threadId)}
    >
      Open thread
    </button>
  );
}

function RunRow({ run }: { run: Run }) {
  const note = run.error ?? run.skipReason;
  return (
    <div className="flex items-center gap-3 rounded-md px-2 py-1 text-sm">
      <span className="w-20 shrink-0 capitalize">{run.status}</span>
      <span className="w-32 shrink-0 text-muted-foreground">
        {formatRunTime(run.startedAt)}
      </span>
      <span className="w-16 shrink-0 text-xs text-muted-foreground">
        {run.trigger}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {note}
      </span>
      {run.threadId && <ThreadLink threadId={run.threadId} />}
    </div>
  );
}
