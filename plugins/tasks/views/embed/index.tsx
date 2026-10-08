import { tasks } from "../../shared/contract.js";
import {
  callOp,
  type MessageDirectiveProps,
  type SidePanelPanelProps,
} from "@bb/plugin/app";
import { useBbNavigate } from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { useTasksQuery } from "../../shell/data.js";
import { PANEL_PATH } from "../../shell/routes.js";
import { DetailView } from "../detail/index.js";
import { PRIORITY_LABELS, STATUS_LABELS } from "../list/lib.js";
import { PriorityIcon, StatusIcon } from "../list/icons.js";

const TASK_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/;
const KEY_CLASS = "shrink-0 font-mono text-xs text-muted-foreground";
const ROW_CLASS = "flex min-w-0 flex-1 items-center gap-2 px-1";
const NOTE_CLASS = "min-w-0 flex-1 truncate text-sm text-muted-foreground";
const SOLID_CARD_CLASS =
  "my-3 flex h-11 items-center gap-1 rounded-lg border border-border bg-card px-2 shadow-sm transition-colors hover:bg-state-hover";
const DASHED_CARD_CLASS =
  "my-3 flex h-11 items-center gap-1 rounded-lg border border-dashed border-border bg-surface-recessed-solid px-2";

function OpenInTasksButton({
  label,
  taskKey,
}: {
  label: string;
  taskKey?: string;
}) {
  const navigate = useBbNavigate();
  const target = taskKey === undefined ? {} : { subPath: `task/${taskKey}` };
  return (
    <Button
      className="size-8 shrink-0"
      size="icon"
      variant="ghost"
      aria-label={label}
      onClick={() => navigate.toPluginPanel(PANEL_PATH, target)}
    >
      <Icon name="ArrowUpRight" className="size-4" />
    </Button>
  );
}

function TaskCard({
  taskKey,
  title,
}: {
  taskKey: string;
  title: string | null;
}) {
  const navigate = useBbNavigate();
  const query = useTasksQuery(
    async () => (await callOp(tasks.getTaskByKey, { taskKey })).task,
    [taskKey],
  );
  const task = query.data;

  if (task === undefined && query.error === null) {
    return (
      <div className={SOLID_CARD_CLASS}>
        <div
          role="status"
          aria-label={`Loading task ${taskKey}`}
          className={ROW_CLASS}
        >
          <Skeleton className="size-3.5 shrink-0 rounded-full" />
          <span className={KEY_CLASS}>{taskKey}</span>
          {title ? (
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">
              {title}
            </span>
          ) : (
            <Skeleton className="h-3.5 w-1/2" />
          )}
        </div>
      </div>
    );
  }
  if (!task) {
    const missing = title
      ? `${title} · not found`
      : "Task not found — deleted, or its key changed";
    return (
      <div className={DASHED_CARD_CLASS}>
        <div className={ROW_CLASS}>
          {task === null ? (
            <StatusIcon status="backlog" />
          ) : (
            <Icon
              name="AlertCircle"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          )}
          <span className={KEY_CLASS}>{taskKey}</span>
          <span className={NOTE_CLASS}>
            {task === null ? missing : "Couldn't load this task"}
          </span>
        </div>
        {task === null ? (
          <OpenInTasksButton label="Open Tasks" />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={query.refresh}
          >
            Retry
          </Button>
        )}
      </div>
    );
  }

  const priority = PRIORITY_LABELS[task.priority].toLowerCase();
  const summary = [
    `${task.key} — ${task.title}`,
    STATUS_LABELS[task.status].toLowerCase(),
    ...(task.priority === "none" ? [] : [`${priority} priority`]),
  ];
  const openInSidePanel = () => {
    const panel = { actionId: "task", title: task.key };
    const params = { taskKey: task.key };
    if (navigate.openThreadPanel({ ...panel, params })) return;
    navigate.toPluginPanel(PANEL_PATH, { subPath: `task/${task.key}` });
  };
  return (
    <div className={SOLID_CARD_CLASS}>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={`${summary.join(", ")} — open in side panel`}
        onClick={openInSidePanel}
      >
        <span aria-hidden>
          <StatusIcon status={task.status} />
        </span>
        <span aria-hidden className={KEY_CLASS}>
          {task.key}
        </span>
        <span
          aria-hidden
          className="min-w-0 flex-1 truncate text-sm font-medium"
        >
          {task.title}
        </span>
        {task.priority !== "none" ? (
          <span aria-hidden className="shrink-0">
            <PriorityIcon priority={task.priority} />
          </span>
        ) : null}
      </button>
      <OpenInTasksButton
        label={`Open ${task.key} in Tasks`}
        taskKey={task.key}
      />
    </div>
  );
}

export function TaskDirectiveCard({ attributes }: MessageDirectiveProps) {
  const taskKey = attributes.key?.trim() ?? "";
  const title = attributes.title?.trim() || null;
  if (TASK_KEY_PATTERN.test(taskKey)) {
    return <TaskCard taskKey={taskKey} title={title} />;
  }
  return (
    <div className="my-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
      Invalid task link. Expected a task key like TSK-4.
    </div>
  );
}

export function TaskEmbedPanel({ params }: SidePanelPanelProps) {
  const given: unknown =
    typeof params === "object" && params !== null
      ? Reflect.get(params, "taskKey")
      : null;
  const taskKey = typeof given === "string" ? given.trim() : "";
  if (!TASK_KEY_PATTERN.test(taskKey)) {
    return (
      <div className="p-3 text-sm text-muted-foreground">
        Open a task card from a message to view it here.
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pb-2">
        <div className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {taskKey}
        </div>
        <OpenInTasksButton
          label={`Open ${taskKey} in Tasks`}
          taskKey={taskKey}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DetailView taskKey={taskKey} />
      </div>
    </div>
  );
}
