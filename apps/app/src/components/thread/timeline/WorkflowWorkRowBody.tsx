import { isSettledWorkflowAgentState } from "@bb/domain";
import type { TimelineViewWorkflowWorkRow } from "@bb/thread-view";
import type { DetailScrollSize } from "../../ui/detail-scroll-size.js";

export function WorkflowWorkRowBody({
  row,
}: {
  row: TimelineViewWorkflowWorkRow;
  size?: DetailScrollSize;
  collapsiblePhases?: boolean;
}) {
  const agents = row.workflow?.agents ?? [];
  const settled = agents.filter((agent) =>
    isSettledWorkflowAgentState(agent.state),
  ).length;
  const summary =
    row.summary ??
    row.error ??
    (agents.length > 0
      ? `${settled} of ${agents.length} agents finished`
      : null);
  if (!summary) return null;
  return (
    <div className="px-2 py-1 text-xs text-muted-foreground">{summary}</div>
  );
}
