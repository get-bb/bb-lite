import type { ThreadTimelineActivePromptMode } from "@bb/domain";
import {
  AnimatedBody,
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PromptStackCard,
  PromptStackCardChevron,
} from "@/components/promptbox/banner/PromptStackCard";
import {
  activityIconClass,
  activityRowClass,
  activityTextClass,
} from "@bb/shared-ui/activity-row-styles";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

const BODY_ID = "thread-prompt-mode-card-body";
const TOGGLE_ID = "thread-prompt-mode-card-toggle";

export function ThreadPromptModeCard({
  activePromptMode,
  isExitPending,
  isExpanded,
  onExitPlanMode,
  onToggle,
}: {
  activePromptMode: ThreadTimelineActivePromptMode | null;
  isExitPending: boolean;
  isExpanded: boolean;
  onExitPlanMode: () => void;
  onToggle: () => void;
}) {
  if (activePromptMode?.mode !== "plan") {
    return null;
  }
  const promptText = activePromptMode.prompt.trim();

  return (
    <PromptStackCard
      ariaLabel="Prompt mode"
      className="overflow-hidden"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div
        role="group"
        aria-label="Plan mode controls"
        className={activityRowClass(
          "active",
          "flex w-full items-stretch rounded-none px-0 py-0",
        )}
      >
        <button
          type="button"
          id={TOGGLE_ID}
          aria-expanded={isExpanded}
          aria-controls={BODY_ID}
          aria-label="Plan"
          onClick={onToggle}
          className="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-none bg-transparent px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-background/80"
        >
          <Icon
            name="ListTodo"
            className={activityIconClass("active", "size-3.5 shrink-0")}
            aria-hidden="true"
          />
          <span
            className={activityTextClass(
              "active",
              "min-w-0 flex-1 truncate text-left",
            )}
          >
            Plan
          </span>
          <PromptStackCardChevron
            isExpanded={isExpanded}
            className={activityIconClass("active")}
          />
        </button>
        <button
          type="button"
          aria-label="Exit plan mode"
          onClick={onExitPlanMode}
          disabled={isExitPending}
          className="flex min-h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-none border-l border-border/35 bg-transparent text-muted-foreground transition-colors hover:text-foreground disabled:cursor-wait disabled:text-muted-foreground/60"
        >
          <Icon
            name={isExitPending ? "Loading" : "X"}
            className={cn("size-3.5", isExitPending && "animate-spin")}
            aria-hidden="true"
          />
        </button>
      </div>
      <AnimatedBody
        id={BODY_ID}
        labelledBy={TOGGLE_ID}
        isExpanded={isExpanded}
        collapsedBorder="none"
      >
        <div className="px-3 pb-2.5 pt-2">
          <p
            className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90"
            title={promptText}
          >
            {promptText.length > 0 ? promptText : "No prompt text."}
          </p>
        </div>
      </AnimatedBody>
    </PromptStackCard>
  );
}
