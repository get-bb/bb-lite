import { isSettledWorkflowAgentState } from "@bb/domain";
import type { TimelineWorkflowWorkRow } from "@bb/server-contract";
import {
  AnimatedBody,
  PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PromptStackCard,
  PromptStackCardChevron,
} from "@/components/promptbox/banner/PromptStackCard";
import { LiveDurationText } from "@/components/thread/timeline/LiveDurationText";
import {
  activityIconClass,
  activityRowClass,
  activityTextClass,
  type ActivityRowState,
} from "@bb/shared-ui/activity-row-styles";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

type WorkflowProgress = NonNullable<TimelineWorkflowWorkRow["workflow"]>;
type WorkflowAgent = WorkflowProgress["agents"][number];

const BODY_ID = "thread-workflow-card-body";
const TOGGLE_ID = "thread-workflow-card-toggle";
const PHASE_DISPLAY = {
  done: { segment: "bg-success/60", title: "text-subtle-foreground" },
  active: { segment: "animate-pulse bg-foreground", title: "text-foreground" },
  failed: { segment: "bg-destructive/70", title: "text-destructive-text" },
  upcoming: {
    segment: "bg-muted-foreground/20",
    title: "text-muted-foreground",
  },
};
const AGENT_DISPLAY: Record<
  WorkflowAgent["state"],
  { icon: IconName; row: ActivityRowState }
> = {
  queued: { icon: "Circle", row: "pending" },
  running: { icon: "Spinner", row: "active" },
  done: { icon: "Check", row: "completed" },
  failed: { icon: "CircleX", row: "failed" },
  skipped: { icon: "Unavailable", row: "muted" },
};

function groupPhases(progress: WorkflowProgress) {
  const phases = progress.phases.map((phase) => {
    const agents = progress.agents.filter(
      (agent) => agent.phaseIndex === phase.index,
    );
    return {
      ...phase,
      agents,
      settled: agents.filter((agent) =>
        isSettledWorkflowAgentState(agent.state),
      ).length,
    };
  });
  const running = (agent: WorkflowAgent) => agent.state === "running";
  const current =
    phases.find((phase) => phase.agents.some(running)) ??
    phases.find((phase) => phase.settled < phase.agents.length) ??
    phases.filter((phase) => phase.agents.length > 0).at(-1);
  return phases.map((phase) => ({
    ...phase,
    state: phase.agents.some((agent) => agent.state === "failed")
      ? ("failed" as const)
      : phase.agents.length > 0 &&
          phase.settled === phase.agents.length &&
          phase !== current
        ? ("done" as const)
        : phase === current || phase.settled > 0 || phase.agents.some(running)
          ? ("active" as const)
          : ("upcoming" as const),
  }));
}

function WorkflowAgentRow({ agent }: { agent: WorkflowAgent }) {
  const display = AGENT_DISPLAY[agent.state];
  const running = agent.state === "running";
  const model = /^claude-([a-z]+)/.exec(agent.model)?.[1] ?? agent.model;
  const meta =
    running || agent.state === "done" ? model : `${model} · ${agent.state}`;
  return (
    <div
      className={activityRowClass(
        display.row,
        "flex min-h-7 w-full min-w-0 items-center gap-2 text-xs shadow-none ring-0",
      )}
    >
      <Icon
        name={display.icon}
        className={cn(
          "size-3.5 shrink-0",
          running
            ? "animate-spin text-foreground"
            : activityIconClass(display.row),
        )}
      />
      <span
        className={cn(
          running
            ? "font-medium text-foreground"
            : activityTextClass(display.row),
          "min-w-0 truncate no-underline",
        )}
        title={agent.label}
      >
        {agent.label}
      </span>
      <span
        className="ml-auto shrink-0 whitespace-nowrap font-mono text-2xs text-subtle-foreground/80"
        title={meta}
      >
        {meta}
      </span>
    </div>
  );
}

export function ThreadWorkflowCard({
  workflow,
  isExpanded,
  onToggle,
}: {
  workflow: TimelineWorkflowWorkRow;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  if (workflow.status !== "pending") {
    return null;
  }
  const name = workflow.workflowName ?? workflow.description;
  const agents = workflow.workflow?.agents ?? [];
  const phases = workflow.workflow ? groupPhases(workflow.workflow) : [];
  const unphased = agents.filter(
    (agent) => !phases.some((phase) => phase.agents.includes(agent)),
  );
  const metaClass = "shrink-0 text-2xs tabular-nums text-muted-foreground";
  return (
    <PromptStackCard
      ariaLabel="Workflow"
      className="overflow-hidden"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div className="flex items-center">
        <button
          type="button"
          id={TOGGLE_ID}
          aria-expanded={isExpanded}
          aria-controls={BODY_ID}
          aria-label={`Workflow: ${name}`}
          onClick={onToggle}
          className={activityRowClass(
            "active",
            PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
          )}
        >
          <Icon
            name="Workflow"
            className={activityIconClass("active", "size-3.5 shrink-0")}
            aria-hidden="true"
          />
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            <span
              className={activityTextClass("active", "min-w-0 truncate")}
              title={name}
            >
              {name}
            </span>
            {agents.length > 0 ? (
              <span className={metaClass}>
                {
                  agents.filter((agent) =>
                    isSettledWorkflowAgentState(agent.state),
                  ).length
                }
                /{agents.length} agents
              </span>
            ) : null}
            <span className={metaClass}>
              <LiveDurationText startedAt={workflow.startedAt} />
            </span>
          </span>
          <PromptStackCardChevron
            isExpanded={isExpanded}
            className={activityIconClass("active")}
          />
        </button>
      </div>
      {phases.length > 0 ? (
        <div
          className="flex gap-1 px-3 pb-2"
          role="presentation"
          aria-hidden="true"
        >
          {phases.map((phase) => (
            <span
              key={phase.index}
              className={cn(
                "h-[3px] min-w-1 flex-1 rounded-full",
                PHASE_DISPLAY[phase.state].segment,
              )}
            />
          ))}
        </div>
      ) : null}
      <AnimatedBody
        id={BODY_ID}
        labelledBy={TOGGLE_ID}
        isExpanded={isExpanded}
        collapsedBorder="none"
      >
        <div className="flex max-h-[288px] flex-col gap-1.5 overflow-y-auto px-2.5 py-2 text-xs">
          {phases.map((phase) => (
            <div key={phase.index} className="flex min-w-0 flex-col">
              <div
                className={cn(
                  "flex items-center gap-1.5 px-2 py-0.5 font-medium",
                  PHASE_DISPLAY[phase.state].title,
                )}
              >
                {phase.title}
                <span className="font-normal tabular-nums text-subtle-foreground">
                  {phase.settled}/{phase.agents.length}
                </span>
              </div>
              {phase.agents.map((agent) => (
                <WorkflowAgentRow key={agent.index} agent={agent} />
              ))}
            </div>
          ))}
          {unphased.map((agent) => (
            <WorkflowAgentRow key={agent.index} agent={agent} />
          ))}
          {agents.length === 0 ? (workflow.summary ?? workflow.error) : null}
        </div>
      </AnimatedBody>
    </PromptStackCard>
  );
}
