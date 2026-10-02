import { Icon, type IconName } from "./icon";
import { cn } from "../../lib/utils";

export type WorkflowProgressAgentState =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "cancelled";

export interface WorkflowProgressAgent {
  id?: string;
  actionable?: boolean;
  index: number;
  label: string;
  state: WorkflowProgressAgentState;
  model: string;
  attempt: number;
  cached: boolean;
  lastProgressAt: number;
  phaseIndex?: number;
  agentType?: string;
  error?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  metadata?: readonly string[];
}

export interface WorkflowProgressPhase {
  index: number;
  title: string;
}

export interface WorkflowProgressSnapshot {
  phases: readonly WorkflowProgressPhase[];
  agents: readonly WorkflowProgressAgent[];
}

interface WorkflowPhaseGroup {
  agents: WorkflowProgressAgent[];
  phase: WorkflowProgressPhase | null;
}

function isSettledAgentState(state: WorkflowProgressAgentState): boolean {
  return (
    state === "done" ||
    state === "failed" ||
    state === "skipped" ||
    state === "cancelled"
  );
}

function groupAgentsByPhase(
  phases: readonly WorkflowProgressPhase[],
  agents: readonly WorkflowProgressAgent[],
): WorkflowPhaseGroup[] {
  const groups: WorkflowPhaseGroup[] = [];
  const byIndex = new Map<number, WorkflowPhaseGroup>();
  for (const phase of phases) {
    const group: WorkflowPhaseGroup = { phase, agents: [] };
    groups.push(group);
    byIndex.set(phase.index, group);
  }
  const unphased: WorkflowProgressAgent[] = [];
  for (const agent of agents) {
    const group =
      agent.phaseIndex !== undefined ? byIndex.get(agent.phaseIndex) : null;
    if (group) group.agents.push(agent);
    else unphased.push(agent);
  }
  if (unphased.length > 0) groups.push({ phase: null, agents: unphased });
  return groups;
}

function groupKey(group: WorkflowPhaseGroup): string {
  return group.phase ? `phase-${group.phase.index}` : "unphased";
}

function activePhaseKey(
  groups: readonly WorkflowPhaseGroup[],
  currentPhaseIndex?: number,
): string | null {
  if (currentPhaseIndex !== undefined) {
    const current = groups.find(
      (group) => group.phase?.index === currentPhaseIndex,
    );
    if (current) return groupKey(current);
  }
  const running = groups.find((group) =>
    group.agents.some((agent) => agent.state === "running"),
  );
  if (running) return groupKey(running);
  const inFlight = groups.find(
    (group) =>
      group.agents.length > 0 &&
      !group.agents.every((agent) => isSettledAgentState(agent.state)),
  );
  if (inFlight) return groupKey(inFlight);
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (group && group.agents.length > 0) return groupKey(group);
  }
  return null;
}

export type WorkflowStatusPillState =
  | "queued"
  | "completed"
  | "failed"
  | "cancelled";

const STATUS_PILL: Record<
  WorkflowStatusPillState,
  { label: string; className: string; icon: IconName | null }
> = {
  queued: {
    label: "Queued",
    className: "bg-surface-recessed text-muted-foreground",
    icon: null,
  },
  completed: {
    label: "Complete",
    className: "bg-success/10 text-success",
    icon: "Check",
  },
  failed: {
    label: "Failed",
    className: "bg-destructive/10 text-destructive-text",
    icon: "X",
  },
  cancelled: {
    label: "Cancelled",
    className: "bg-surface-recessed text-subtle-foreground",
    icon: "Pause",
  },
};

export function WorkflowStatusPill({
  state,
  className,
}: {
  state: WorkflowStatusPillState;
  className?: string;
}) {
  const entry = STATUS_PILL[state];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-2xs font-medium",
        entry.className,
        className,
      )}
    >
      {entry.icon === null ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50"
          aria-hidden="true"
        />
      ) : (
        <Icon
          name={entry.icon}
          className="size-3 shrink-0"
          aria-hidden="true"
        />
      )}
      {entry.label}
    </span>
  );
}

type PhaseStripSegmentState = "done" | "active" | "failed" | "upcoming";

function phaseStripSegmentState(
  group: WorkflowPhaseGroup,
  isCurrent: boolean,
  workflowSettled: boolean,
): PhaseStripSegmentState {
  if (group.agents.some((agent) => agent.state === "failed")) return "failed";
  const total = group.agents.length;
  const settled = group.agents.filter((agent) =>
    isSettledAgentState(agent.state),
  ).length;
  if (total > 0 && settled === total && (workflowSettled || !isCurrent)) {
    return "done";
  }
  if (
    (isCurrent && !workflowSettled) ||
    group.agents.some((agent) => agent.state === "running") ||
    settled > 0
  ) {
    return "active";
  }
  if (workflowSettled && total > 0) return "done";
  return "upcoming";
}

const PHASE_STRIP_SEGMENT_CLASS: Record<PhaseStripSegmentState, string> = {
  done: "bg-success/60",
  active: "animate-pulse bg-foreground",
  failed: "bg-destructive/70",
  upcoming: "bg-muted-foreground/20",
};

export function WorkflowPhaseStrip({
  progress,
  currentPhaseIndex,
  settled,
  className,
}: {
  progress: WorkflowProgressSnapshot;
  currentPhaseIndex?: number;
  settled: boolean;
  className?: string;
}) {
  const groups = groupAgentsByPhase(progress.phases, progress.agents).filter(
    (group): group is WorkflowPhaseGroup & { phase: WorkflowProgressPhase } =>
      group.phase !== null,
  );
  if (groups.length === 0) return null;
  const runningKey = activePhaseKey(groups, currentPhaseIndex);
  return (
    <div
      className={cn("flex gap-1", className)}
      role="presentation"
      aria-hidden="true"
    >
      {groups.map((group) => (
        <span
          key={group.phase.index}
          className={cn(
            "h-[3px] min-w-1 flex-1 rounded-full",
            PHASE_STRIP_SEGMENT_CLASS[
              phaseStripSegmentState(
                group,
                groupKey(group) === runningKey,
                settled,
              )
            ],
          )}
        />
      ))}
    </div>
  );
}
