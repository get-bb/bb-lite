import type {
  ThreadTimelinePendingTodoItemStatus,
  ThreadTimelinePendingTodos,
} from "@bb/domain";
import {
  AnimatedBody,
  PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PromptStackCard,
  PromptStackCardChevron,
} from "@/components/promptbox/banner/PromptStackCard";
import {
  activityIconClass,
  activityRowClass,
  activityTextClass,
  type ActivityRowState,
} from "@bb/shared-ui/activity-row-styles";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

const STATUS: Record<
  ThreadTimelinePendingTodoItemStatus,
  { rank: number; state: ActivityRowState }
> = {
  in_progress: { rank: 0, state: "active" },
  pending: { rank: 1, state: "pending" },
  completed: { rank: 2, state: "completed" },
};
const BODY_ID = "thread-todo-card-body";
const TOGGLE_ID = "thread-todo-card-toggle";

export function ThreadTodoCard({
  pendingTodos,
  isExpanded,
  onToggle,
}: {
  pendingTodos: ThreadTimelinePendingTodos | null;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const items = pendingTodos?.items ?? [];
  if (items.length === 0) {
    return null;
  }
  const completedCount = items.filter(
    (item) => item.status === "completed",
  ).length;
  const ordered = [...items].sort(
    (a, b) => STATUS[a.status].rank - STATUS[b.status].rank,
  );
  return (
    <PromptStackCard
      ariaLabel="To-do list"
      className="overflow-hidden"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div className="flex items-center">
        <button
          type="button"
          id={TOGGLE_ID}
          aria-expanded={isExpanded}
          aria-controls={BODY_ID}
          aria-label={`To-do list: ${completedCount} of ${items.length} ${
            items.length === 1 ? "item" : "items"
          } complete`}
          onClick={onToggle}
          className={activityRowClass(
            "active",
            PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
          )}
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
            {completedCount}/{items.length} complete
          </span>
          <PromptStackCardChevron
            isExpanded={isExpanded}
            className={activityIconClass("active")}
          />
        </button>
      </div>
      <AnimatedBody
        id={BODY_ID}
        labelledBy={TOGGLE_ID}
        isExpanded={isExpanded}
        collapsedBorder="none"
      >
        <ul className="max-h-40 space-y-1 overflow-y-auto px-2.5 pb-2 pt-2">
          {ordered.map((item) => {
            const { state } = STATUS[item.status];
            return (
              <li
                key={item.id}
                className={activityRowClass(
                  state,
                  cn(
                    "flex min-w-0 items-center gap-2 text-xs",
                    state === "active" && "shadow-none ring-0",
                  ),
                )}
              >
                <Icon
                  name={item.status === "completed" ? "Check" : "Square"}
                  className={cn(
                    "size-3.5 shrink-0",
                    state === "active"
                      ? "text-foreground"
                      : activityIconClass(state),
                  )}
                  aria-hidden="true"
                />
                <span
                  className={activityTextClass(
                    state,
                    "min-w-0 flex-1 truncate",
                  )}
                  title={item.text}
                >
                  {item.text}
                </span>
              </li>
            );
          })}
        </ul>
      </AnimatedBody>
    </PromptStackCard>
  );
}
