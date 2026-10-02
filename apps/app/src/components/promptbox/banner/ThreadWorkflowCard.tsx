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
import { WorkflowWorkRowBody } from "@/components/thread/timeline/WorkflowWorkRowBody";
import {
  activityIconClass,
  activityMetaClass,
  activityRowClass,
  activityTextClass,
} from "@bb/shared-ui/activity-row-styles";
import { Icon } from "@bb/shared-ui/icon";
import { WorkflowPhaseStrip } from "@bb/shared-ui/workflow-progress";

const BODY_ID = "thread-workflow-card-body";
const TOGGLE_ID = "thread-workflow-card-toggle";

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
  const metaClass = activityMetaClass(
    "active",
    "shrink-0 text-2xs tabular-nums",
  );
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
      {workflow.workflow ? (
        <WorkflowPhaseStrip
          progress={workflow.workflow}
          settled={false}
          className="px-3 pb-2"
        />
      ) : null}
      <AnimatedBody
        id={BODY_ID}
        labelledBy={TOGGLE_ID}
        isExpanded={isExpanded}
        collapsedBorder="none"
      >
        <WorkflowWorkRowBody row={workflow} size="base" collapsiblePhases />
      </AnimatedBody>
    </PromptStackCard>
  );
}
