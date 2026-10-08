import { definePluginApp, threadView } from "@bb/plugin/app";
import {
  ConversationTimelineRow,
  DelegationWorkRowDetail,
  SummaryTimelineRow,
  SystemTimelineRow,
  TurnTimelineRow,
  WorkTimelineRow,
} from "@/components/thread/timeline/ThreadTimelineRows";
import {
  CommandWorkRowDetail,
  EmptyWorkRowDetail,
  FileChangeWorkRowDetail,
  ImageWorkRowDetail,
  PlanStepsWorkRowDetail,
  PresentationWorkRowDetail,
  QuestionWorkRowDetail,
  ToolWorkRowDetail,
  WorkflowWorkRowDetail,
} from "@/components/thread/timeline/TimelineRowDetails";

export default definePluginApp((bb) => {
  bb.add(threadView.row, {
    kind: "conversation",
    view: ConversationTimelineRow,
  });
  bb.add(threadView.row, { kind: "turn", view: TurnTimelineRow });
  bb.add(threadView.row, { kind: "work", view: WorkTimelineRow });
  bb.add(threadView.row, { kind: "system", view: SystemTimelineRow });
  bb.add(threadView.row, { kind: "bundle-summary", view: SummaryTimelineRow });
  bb.add(threadView.row, { kind: "step-summary", view: SummaryTimelineRow });

  bb.add(threadView.rowDetail, { kind: "command", view: CommandWorkRowDetail });
  bb.add(threadView.rowDetail, { kind: "tool", view: ToolWorkRowDetail });
  bb.add(threadView.rowDetail, {
    kind: "file-change",
    view: FileChangeWorkRowDetail,
  });
  bb.add(threadView.rowDetail, {
    kind: "question",
    view: QuestionWorkRowDetail,
  });
  bb.add(threadView.rowDetail, {
    kind: "form",
    view: PresentationWorkRowDetail,
  });
  bb.add(threadView.rowDetail, {
    kind: "extension",
    view: PresentationWorkRowDetail,
  });
  bb.add(threadView.rowDetail, {
    kind: "workflow",
    view: WorkflowWorkRowDetail,
  });
  bb.add(threadView.rowDetail, {
    kind: "plan-steps",
    view: PlanStepsWorkRowDetail,
  });
  bb.add(threadView.rowDetail, {
    kind: "image-generation",
    view: ImageWorkRowDetail,
  });
  bb.add(threadView.rowDetail, {
    kind: "image-view",
    view: ImageWorkRowDetail,
  });
  bb.add(threadView.rowDetail, {
    kind: "delegation",
    view: DelegationWorkRowDetail,
  });
  for (const kind of [
    "approval",
    "web-search",
    "web-fetch",
    "file-read",
    "search",
  ]) {
    bb.add(threadView.rowDetail, { kind, view: EmptyWorkRowDetail });
  }
});
