import { useRef, useState } from "react";
import { isBackgroundAgentTaskType } from "@bb/domain";
import type { TimelineWorkflowWorkRow } from "@bb/server-contract";
import { useResizeObserver } from "usehooks-ts";
import {
  AnimatedBody,
  PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PromptStackCard,
  PromptStackCardChevron,
} from "@/components/promptbox/banner/PromptStackCard";
import { LiveDurationText } from "@/components/thread/timeline/LiveDurationText";
import { Icon } from "@bb/shared-ui/icon";
import {
  activityIconClass,
  activityRowClass,
  activityTextClass,
} from "@bb/shared-ui/activity-row-styles";
import { cn } from "@bb/shared-ui/lib/utils";

const BODY_ID = "thread-background-commands-card-body";
const TOGGLE_ID = "thread-background-commands-card-toggle";
const COMPACT_PROMPT_SHELL_MAX_WIDTH_REM = 34;

const isAgent = (row: TimelineWorkflowWorkRow) =>
  isBackgroundAgentTaskType(row.taskType);
const iconOf = (row: TimelineWorkflowWorkRow) =>
  isAgent(row) ? "UserRoundPlus" : "Terminal";
const kindOf = (row: TimelineWorkflowWorkRow) =>
  isAgent(row) ? "background agent" : "background command";
const plural = (count: number, noun: string) =>
  `Running ${count} ${noun}${count === 1 ? "" : "s"}`;

function ariaLabelOf(row: TimelineWorkflowWorkRow, label: string): string {
  return isAgent(row) && row.model
    ? `${label}: ${row.description} · Model ${row.model}`
    : `${label}: ${row.description}`;
}

function BackgroundActivitySummary({
  row,
  showDuration,
}: {
  row: TimelineWorkflowWorkRow;
  showDuration: boolean;
}) {
  const model = isAgent(row) ? row.model : null;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1 text-left">
      <span className="shrink-0 whitespace-nowrap text-muted-foreground">
        Running {kindOf(row)}:
      </span>
      <span
        className={cn("min-w-0 truncate", activityTextClass("active"))}
        title={row.description}
      >
        {row.description}
      </span>
      {model ? (
        <span
          className="shrink-0 whitespace-nowrap font-mono text-2xs text-muted-foreground"
          title={`Model: ${model}`}
        >
          {model}
        </span>
      ) : null}
      {showDuration ? (
        <span className="shrink-0 tabular-nums text-muted-foreground">
          <LiveDurationText startedAt={row.startedAt} />
        </span>
      ) : null}
    </span>
  );
}

export function ThreadBackgroundCommandsCard({
  commands,
  isExpanded,
  onToggle,
}: {
  commands: TimelineWorkflowWorkRow[];
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const cardRef = useRef<HTMLElement>(null!);
  const [useCompactSummary, setUseCompactSummary] = useState(false);
  useResizeObserver({
    ref: cardRef,
    box: "border-box",
    onResize: ({ width }) => {
      if (width === undefined) return;
      const rootFontSize =
        Number.parseFloat(
          window.getComputedStyle(document.documentElement).fontSize,
        ) || 16;
      setUseCompactSummary(
        width <= COMPACT_PROMPT_SHELL_MAX_WIDTH_REM * rootFontSize,
      );
    },
  });
  const primary = commands[0];
  if (!primary) {
    return null;
  }
  const others = commands.slice(1);
  const canExpand = others.length > 0 || useCompactSummary;
  const agentCount = commands.filter(isAgent).length;
  const commandCount = commands.length - agentCount;
  const compactLabel =
    commandCount === 0
      ? plural(agentCount, "background agent")
      : agentCount === 0
        ? plural(commandCount, "background command")
        : `Running ${commands.length} background activities`;
  const groupLabel =
    agentCount > 0 && commandCount > 0
      ? "Background activity"
      : agentCount > 0
        ? "Background agents"
        : "Background commands";

  return (
    <PromptStackCard
      rootRef={cardRef}
      ariaLabel={groupLabel}
      className="overflow-hidden"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div className="flex items-center">
        {canExpand ? (
          <button
            type="button"
            id={TOGGLE_ID}
            aria-expanded={isExpanded}
            aria-controls={BODY_ID}
            aria-label={
              useCompactSummary
                ? compactLabel
                : ariaLabelOf(primary, groupLabel)
            }
            onClick={onToggle}
            className={activityRowClass(
              "active",
              PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
            )}
          >
            <Icon
              name={iconOf(primary)}
              className={activityIconClass("active", "size-3.5 shrink-0")}
              aria-hidden="true"
            />
            {useCompactSummary ? (
              <span className="min-w-0 flex-1 truncate text-left font-medium">
                {compactLabel}
              </span>
            ) : (
              <>
                <BackgroundActivitySummary row={primary} showDuration={false} />
                <span className="shrink-0 text-muted-foreground">
                  +{others.length} more
                </span>
              </>
            )}
            <PromptStackCardChevron
              isExpanded={isExpanded}
              className={activityIconClass("active")}
            />
          </button>
        ) : (
          <div
            className={activityRowClass(
              "active",
              "flex min-h-8 w-full min-w-0 cursor-default items-center gap-1.5 rounded-none px-3 py-1.5 text-xs text-foreground",
            )}
            aria-label={ariaLabelOf(
              primary,
              isAgent(primary) ? "Background agent" : "Background command",
            )}
          >
            <Icon
              name={iconOf(primary)}
              className={activityIconClass("active", "size-3.5 shrink-0")}
              aria-hidden="true"
            />
            <BackgroundActivitySummary row={primary} showDuration />
          </div>
        )}
      </div>
      {canExpand ? (
        <AnimatedBody
          id={BODY_ID}
          labelledBy={TOGGLE_ID}
          isExpanded={isExpanded}
          collapsedBorder="none"
        >
          <div className="flex flex-col gap-0.5 py-1">
            {(useCompactSummary ? commands : others).map((row) => (
              <div
                key={row.id}
                className={cn(
                  "flex min-w-0 gap-1.5 px-3 py-0.5 text-xs",
                  useCompactSummary ? "items-start" : "items-center",
                )}
              >
                <Icon
                  name={iconOf(row)}
                  className="size-3.5 shrink-0 text-muted-foreground/60"
                  aria-hidden="true"
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 text-muted-foreground",
                    useCompactSummary
                      ? "whitespace-normal [overflow-wrap:anywhere]"
                      : "truncate",
                  )}
                  title={row.description}
                >
                  {row.description}
                </span>
                {isAgent(row) && row.model ? (
                  <span
                    className="shrink-0 whitespace-nowrap font-mono text-2xs text-subtle-foreground"
                    title={`Model: ${row.model}`}
                  >
                    {row.model}
                  </span>
                ) : null}
                <span className="shrink-0 whitespace-nowrap tabular-nums text-subtle-foreground">
                  {isExpanded ? (
                    <LiveDurationText startedAt={row.startedAt} />
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        </AnimatedBody>
      ) : null}
    </PromptStackCard>
  );
}
