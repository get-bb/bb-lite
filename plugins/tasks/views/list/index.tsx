import { callOp } from "@bb/plugin/app";
import { useCallback, useMemo, useState } from "react";
import { tasks as ops, type Task } from "../../shared/contract.js";
import {
  reportError,
  useLabels,
  useOverview,
  useTasksQuery,
} from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { EmptyState } from "../../components/common.js";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { ListFilterBar } from "./filter-bar.js";
import { StatusIcon } from "./icons.js";
import {
  EMPTY_FILTERS,
  groupTasksByStatus,
  labelFilterOptions,
  loadListPreference,
  STATUS_LABELS,
  storeListPreference,
  type ListPreference,
} from "./lib.js";
import { TaskRow, type TaskEdit } from "./row.js";

export function ListView({
  projectId,
  activeOnly = false,
  onNewTask,
}: {
  projectId: string | null;
  activeOnly?: boolean;
  onNewTask: () => void;
}) {
  const navigation = useTasksNavigation();
  const overview = useOverview();
  const labels = useLabels(projectId ?? undefined);
  const scope =
    projectId === null
      ? activeOnly
        ? "active"
        : "all"
      : `project:${projectId}`;
  const [preference, setPreference] = useState(() => loadListPreference(scope));
  const change = (patch: Partial<ListPreference>) => {
    const next = { ...preference, ...patch };
    storeListPreference(scope, next);
    setPreference(next);
  };
  const { statuses, priorities, labelNames, sort } = preference;

  const labelOptions = useMemo(
    () => labelFilterOptions(labels.data ?? []),
    [labels.data],
  );
  const labelIds = labelOptions
    .filter((option) => labelNames.includes(option.name))
    .flatMap((option) => option.labelIds);
  const filters = {
    ...(projectId === null ? {} : { projectId }),
    ...(statuses.length > 0 ? { statuses } : {}),
    ...(priorities.length > 0 ? { priorities } : {}),
    ...(labelNames.length > 0 ? { labelIds } : {}),
    activeOnly,
    parentTaskId: null,
    sort,
  };
  const query = useTasksQuery(() => callOp(ops.listTasks, filters), [filters]);
  const awaitingLabels = labelNames.length > 0 && labels.data === undefined;
  const tasks = awaitingLabels ? undefined : query.data?.tasks;
  const groups = useMemo(() => groupTasksByStatus(tasks ?? []), [tasks]);
  const labelsById = useMemo(
    () => new Map((labels.data ?? []).map((label) => [label.id, label])),
    [labels.data],
  );
  const projects = overview.data?.projects;

  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const { refresh } = query;
  const edit = useCallback(
    (task: Task, patch: TaskEdit) => {
      const others = (ids: ReadonlySet<string>) =>
        [...ids].filter((id) => id !== task.id);
      setPending((current) => new Set([...current, task.id]));
      callOp(ops.updateTask, { taskId: task.id, ...patch })
        .then(refresh, reportError)
        .finally(() => setPending((current) => new Set(others(current))));
    },
    [refresh],
  );
  const openTask = useCallback(
    (taskKey: string) => navigation.go({ kind: "task", taskKey }),
    [navigation],
  );

  let body: React.ReactNode = null;
  if (tasks === undefined) {
    body = query.error ? (
      <EmptyState
        icon="AlertCircle"
        title="Couldn't load tasks"
        description={query.error}
      />
    ) : null;
  } else if (tasks.length > 0) {
    body = groups.map((group) => (
      <section key={group.status}>
        <div
          data-status-group-header={group.status}
          className="sticky top-0 z-20 isolate flex items-center gap-2 border-b border-border-hairline bg-background px-3.5 pb-1.5 pt-2.5 text-sm font-semibold"
        >
          <StatusIcon status={group.status} />
          {STATUS_LABELS[group.status]}
          <span className="text-xs font-normal tabular-nums text-subtle-foreground">
            {group.tasks.length}
          </span>
        </div>
        {group.tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            activeThreads={query.data?.activeThreads[task.id]}
            project={
              projectId === null
                ? projects?.find((project) => project.id === task.projectId)
                : undefined
            }
            labelsById={labelsById}
            onEdit={edit}
            onOpen={openTask}
            pending={pending.has(task.id)}
          />
        ))}
      </section>
    ));
  } else if (statuses.length + priorities.length + labelNames.length > 0) {
    body = (
      <EmptyState
        icon="Search"
        title="No tasks match these filters"
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => change(EMPTY_FILTERS)}
          >
            Clear filters
          </Button>
        }
      />
    );
  } else if (activeOnly) {
    body = (
      <EmptyState
        icon="Zap"
        title="No agents working right now"
        description="Dispatch a task to an agent preset and it will show up here while it runs."
      />
    );
  } else {
    body = (
      <EmptyState
        icon="ListTodo"
        title="No tasks yet"
        description="Create the first task to start tracking work."
        action={
          <Button size="sm" onClick={onNewTask}>
            <Icon name="Plus" className="size-3.5" />
            New task
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ListFilterBar
        preference={preference}
        onChange={change}
        labelOptions={labelOptions}
        taskCount={tasks?.length}
      />
      <div className="min-h-0 flex-1 overflow-y-auto @container">{body}</div>
    </div>
  );
}
