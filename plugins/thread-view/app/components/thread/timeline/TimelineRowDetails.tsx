import { useEffect, useState, type ComponentType } from "react";
import type { ThreadEventPlanStep } from "@bb/domain";
import type { TimelineRowDetailProps } from "@bb/plugin/app";
import type { TimelineRowPresentation } from "@bb/server-contract";
import {
  assertNever,
  fileNameFromPath,
  type TimelineViewWorkRow,
} from "@bb/thread-view";
import { formatPendingInteractionUserQuestionOptionLabel } from "@bb/core-ui";
import {
  activityIconClass,
  activityRowClass,
  activityTextClass,
  type ActivityRowState,
} from "@bb/shared-ui/activity-row-styles";
import { Button } from "@bb/shared-ui/button";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { EventCodeBlock } from "../../ui/event-code-block";
import { ImageLightbox } from "@bb/app-kit/components/ui/image-lightbox";
import { MarkdownPreview } from "@bb/app-kit/components/ui/markdown-preview";
import { buildThreadHostFileContentUrl } from "@bb/app-kit/lib/file-content-urls";
import { TerminalOutputBlock } from "./TerminalOutputBlock";
import { TimelineDetailScroll } from "./TimelineDetailScroll";
import { TimelineFileDiffBlock } from "./TimelineFileDiffBlock";
import { ToolCallDetailBlock } from "./ToolCallDetailBlock";
import { WorkflowWorkRowBody } from "./WorkflowWorkRowBody";
import { useTimeline } from "./timeline-context";
import {
  useTimelineWorkRowFullOutput,
  type TimelinePreviewableWorkRow,
  type TimelineWorkRowFullOutput,
} from "./useTimelineWorkRowFullOutput";

type WorkRow<Kind extends TimelineViewWorkRow["workKind"]> = Extract<
  TimelineViewWorkRow,
  { workKind: Kind }
>;
type PlanStepStatus = NonNullable<ThreadEventPlanStep["status"]>;

const PLAN_STEP_ACTIVITY_STATE: Record<PlanStepStatus, ActivityRowState> = {
  pending: "pending",
  active: "active",
  completed: "completed",
  failed: "completed",
};

const PLAN_STEP_ICON: Record<PlanStepStatus, IconName> = {
  pending: "Square",
  active: "Square",
  completed: "Check",
  failed: "X",
};

function PresentationDetail({
  presentation,
}: {
  presentation: TimelineRowPresentation | undefined;
}) {
  const detail = presentation?.detail;
  if (detail === undefined || detail.trim().length === 0) {
    return null;
  }
  return (
    <MarkdownPreview
      content={detail}
      className="text-xs text-muted-foreground"
      imagePolicy="alt-text"
    />
  );
}

function ImageWorkRowBody({
  row,
}: {
  row: WorkRow<"image-view" | "image-generation">;
}) {
  const [loadError, setLoadError] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const generationError =
    row.workKind === "image-generation" ? row.error : null;
  const imageSrc =
    !row.path || generationError
      ? null
      : buildThreadHostFileContentUrl(row.threadId, row.path);
  const imageName = row.path ? fileNameFromPath(row.path) : "";
  const imageAlt = `${row.workKind === "image-generation" ? "Generated" : "Viewed"} image: ${imageName}`;

  useEffect(() => {
    setLoadError(false);
    setLightboxOpen(false);
  }, [imageSrc, row.completedAt, row.status]);

  if (loadError || !imageSrc) {
    return (
      <EmptyStatePanel className="rounded-lg">
        <div className="whitespace-pre-wrap break-words">
          {generationError || "Image preview unavailable."}
        </div>
        <div className="mt-1 break-all font-mono text-xs">{row.path}</div>
      </EmptyStatePanel>
    );
  }

  return (
    <>
      <button
        type="button"
        className="block w-full max-w-80 cursor-zoom-in overflow-hidden rounded-lg border border-border bg-surface-recessed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:max-w-96"
        onClick={() => setLightboxOpen(true)}
        aria-label={`Open image preview: ${imageName}`}
      >
        <img
          src={imageSrc}
          alt=""
          className="block h-auto w-full object-contain"
          loading="lazy"
          decoding="async"
          onError={() => setLoadError(true)}
        />
      </button>
      <ImageLightbox
        imageAlt={imageAlt}
        imageSrc={lightboxOpen ? imageSrc : null}
        onClose={() => setLightboxOpen(false)}
        title={imageAlt}
      />
    </>
  );
}

function OutputPreviewNote({
  fullOutput,
  row,
}: {
  fullOutput: TimelineWorkRowFullOutput;
  row: TimelinePreviewableWorkRow;
}) {
  if (row.outputPreview === undefined) {
    return null;
  }
  const total = `${row.outputPreview.totalChars.toLocaleString()} characters`;
  const text = {
    "streaming-preview": `Preview of ${total}. The full output loads when this finishes.`,
    "limited-preview": `Preview of ${total}. The full output exceeds the detail response limit.`,
    "expired-preview": `Preview of ${total}. The full output is no longer available because its retention period ended.`,
    loading: `Loading the full output (${total})…`,
    error: `Failed to load the full output (${total}).`,
    complete: null,
    loaded: null,
  }[fullOutput.state];
  if (text === null) {
    return null;
  }
  return (
    <div
      className="flex items-center gap-2 text-xs text-muted-foreground"
      data-testid="timeline-output-preview-note"
    >
      <span>{text}</span>
      {fullOutput.state === "error" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={fullOutput.retry}
          className="h-6 cursor-pointer px-2"
        >
          <Icon name="RotateCcw" />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function CommandWorkRowBody({ row }: { row: WorkRow<"command"> }) {
  const fullOutput = useTimelineWorkRowFullOutput(row);
  return (
    <div className="space-y-1">
      <TerminalOutputBlock
        commandLine={`$ ${row.command}`}
        metadataLines={row.source ? [`source: ${row.source}`] : []}
        output={fullOutput.output}
        exitCode={row.exitCode}
        streaming={row.status === "pending"}
      />
      <OutputPreviewNote fullOutput={fullOutput} row={row} />
    </div>
  );
}

function ToolWorkRowBody({ row }: { row: WorkRow<"tool"> }) {
  const fullOutput = useTimelineWorkRowFullOutput(row);
  return (
    <div className="space-y-1">
      <PresentationDetail presentation={row.presentation} />
      <ToolCallDetailBlock
        toolName={row.toolName}
        args={row.toolArgs}
        output={fullOutput.output}
        streaming={row.status === "pending"}
      />
      <OutputPreviewNote fullOutput={fullOutput} row={row} />
    </div>
  );
}

function PlanStepsWorkRowBody({ row }: { row: WorkRow<"plan-steps"> }) {
  return (
    <div className="space-y-2">
      <PresentationDetail presentation={row.presentation} />
      {row.explanation ? (
        <p className="text-xs text-muted-foreground">{row.explanation}</p>
      ) : null}
      <ul className="space-y-1" data-testid="plan-steps-body">
        {row.steps.map((step, index) => {
          const status = step.status ?? "pending";
          const activityState = PLAN_STEP_ACTIVITY_STATE[status];
          return (
            <li
              key={`${index}:${step.step}`}
              className={activityRowClass(
                activityState,
                "flex min-w-0 items-center gap-2 text-xs",
              )}
              data-plan-step-status={status}
            >
              <Icon
                name={PLAN_STEP_ICON[status]}
                className={cn(
                  "size-3.5 shrink-0",
                  status === "active"
                    ? "text-foreground"
                    : activityIconClass(activityState),
                )}
                aria-hidden="true"
              />
              <span
                className={activityTextClass(
                  activityState,
                  "min-w-0 flex-1 truncate",
                )}
                title={step.step}
              >
                {step.step}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function QuestionWorkRowBody({ row }: { row: WorkRow<"question"> }) {
  if (row.lifecycle !== "answered" && row.lifecycle !== "resolving") {
    return null;
  }
  return (
    <div className="space-y-3 text-xs leading-snug">
      {row.questions.map((question) => {
        const answer = row.answers?.[question.id] ?? null;
        const selectedLabels =
          answer?.selected.map((value) =>
            formatPendingInteractionUserQuestionOptionLabel({
              question,
              value,
            }),
          ) ?? [];
        const freeText = answer?.freeText ?? null;
        return (
          <div key={question.id}>
            <div className="text-subtle-foreground">{question.prompt}</div>
            {selectedLabels.length > 0 || freeText !== null ? (
              <div className="mt-0.5 text-foreground">
                {selectedLabels.length > 0 ? (
                  <div>{selectedLabels.join(", ")}</div>
                ) : null}
                {freeText ? (
                  <div className="whitespace-pre-wrap">{freeText}</div>
                ) : null}
              </div>
            ) : (
              <div className="mt-0.5 text-subtle-foreground">No answer</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FileChangeWorkRowBody({ row }: { row: WorkRow<"file-change"> }) {
  const { workspaceRootPath } = useTimeline();
  return (
    <div className="space-y-2">
      <TimelineFileDiffBlock
        change={row.change}
        workspaceRootPath={workspaceRootPath}
      />
      {row.stderr ? (
        <TimelineDetailScroll
          size="base"
          contentKey={row.stderr}
          className="rounded-md"
        >
          <EventCodeBlock
            tone="danger"
            className="rounded-none border-0 px-2 py-1.5"
          >
            {row.stderr}
          </EventCodeBlock>
        </TimelineDetailScroll>
      ) : null}
    </div>
  );
}

function PresentationWorkRowBody({
  row,
}: {
  row: WorkRow<"form" | "extension">;
}) {
  return <PresentationDetail presentation={row.presentation} />;
}

function WorkflowDetailWorkRowBody({ row }: { row: WorkRow<"workflow"> }) {
  return (
    <div className="space-y-2">
      <PresentationDetail presentation={row.presentation} />
      <WorkflowWorkRowBody row={row} />
    </div>
  );
}

function EmptyWorkRowBody(_props: { row: TimelineViewWorkRow }) {
  return null;
}

function detailView<Row extends TimelineViewWorkRow>(
  view: ComponentType<{ row: Row }>,
): ComponentType<TimelineRowDetailProps> {
  return view as ComponentType<TimelineRowDetailProps>;
}

export const CommandWorkRowDetail = detailView(CommandWorkRowBody);
export const ToolWorkRowDetail = detailView(ToolWorkRowBody);
export const FileChangeWorkRowDetail = detailView(FileChangeWorkRowBody);
export const QuestionWorkRowDetail = detailView(QuestionWorkRowBody);
export const PresentationWorkRowDetail = detailView(PresentationWorkRowBody);
export const WorkflowWorkRowDetail = detailView(WorkflowDetailWorkRowBody);
export const PlanStepsWorkRowDetail = detailView(PlanStepsWorkRowBody);
export const ImageWorkRowDetail = detailView(ImageWorkRowBody);
export const EmptyWorkRowDetail = detailView(EmptyWorkRowBody);

export function WorkRowBody({ row }: { row: TimelineViewWorkRow }) {
  const View = useTimeline().rowDetailViews.get(row.workKind);
  if (View === undefined) {
    return assertNever(row as never);
  }
  return <View row={row} />;
}
