import { memo, useState } from "react";
import type {
  Label,
  Project,
  Task,
  UpdateTaskInput,
} from "../../shared/contract.js";
import { cn } from "@bb/shared-ui/lib/utils";
import { activeWorkLabel } from "./lib.js";
import { isBareKey, PriorityEditor, StatusEditor } from "./property-menus.js";

export type TaskEdit = Pick<UpdateTaskInput, "status" | "priority">;

const RAIL_CHIP_CLASS =
  "flex items-center gap-1 rounded-md border border-border px-1.5 py-px text-xs text-muted-foreground";

function LabelChipRow({
  labels,
  maxVisible,
}: {
  labels: readonly Label[];
  maxVisible: number;
}) {
  const hidden = labels.slice(maxVisible);
  return (
    <>
      {labels.slice(0, maxVisible).map((label) => (
        <span key={label.id} className={`${RAIL_CHIP_CLASS} max-w-32`}>
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: label.color }}
          />
          <span className="truncate">{label.name}</span>
        </span>
      ))}
      {hidden.length > 0 ? (
        <span
          title={hidden.map((label) => label.name).join(", ")}
          className={`${RAIL_CHIP_CLASS} tabular-nums`}
        >
          +{hidden.length}
        </span>
      ) : null}
    </>
  );
}

interface TaskRowProps {
  task: Task;
  activeThreads: readonly string[] | undefined;
  project: Project | undefined;
  labelsById: ReadonlyMap<string, Label>;
  onEdit: (task: Task, patch: TaskEdit) => void;
  onOpen: (taskKey: string) => void;
  pending: boolean;
}

export const TaskRow = memo(function TaskRow({
  task,
  activeThreads,
  project,
  labelsById,
  onEdit,
  onOpen,
  pending,
}: TaskRowProps) {
  const [openMenu, setOpenMenu] = useState<"status" | "priority" | null>(null);
  const labels = task.labelIds.flatMap((id) => labelsById.get(id) ?? []);

  return (
    <div
      data-task-key={task.key}
      aria-busy={pending || undefined}
      className={cn(
        "relative grid w-full grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 border-b border-border-hairline px-3.5 py-1.5 text-left transition-opacity hover:bg-state-hover",
        "@md:flex @md:h-[34px] @md:py-0",
        pending && "opacity-70",
      )}
    >
      <button
        type="button"
        aria-label={`Open ${task.key}: ${task.title}`}
        onClick={() => onOpen(task.key)}
        onKeyDown={(event) => {
          if (!isBareKey(event)) return;
          const key = event.key.toLowerCase();
          if (key !== "s" && key !== "p") return;
          event.preventDefault();
          setOpenMenu(key === "s" ? "status" : "priority");
        }}
        className="absolute inset-0 rounded-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      />
      <PriorityEditor
        value={task.priority}
        onSelect={(priority) => onEdit(task, { priority })}
        open={openMenu === "priority"}
        onOpenChange={(next) => setOpenMenu(next ? "priority" : null)}
        className="col-start-1 row-start-2"
      />
      <span className="col-start-2 row-start-2 min-w-0 truncate text-xs tabular-nums text-subtle-foreground @max-md:max-w-32 @md:w-14 @md:shrink-0">
        {task.key}
      </span>
      <StatusEditor
        value={task.status}
        onSelect={(status) => onEdit(task, { status })}
        open={openMenu === "status"}
        onOpenChange={(next) => setOpenMenu(next ? "status" : null)}
        className="col-start-1 row-start-1"
      />
      <span className="col-start-2 col-span-2 row-start-1 min-w-0 truncate text-sm @md:flex-1">
        {task.title}
      </span>
      <span className="col-start-3 row-start-2 flex min-w-0 items-center gap-1.5 justify-self-end text-xs text-subtle-foreground @max-md:overflow-hidden @md:shrink-0">
        {activeThreads ? (
          <span
            title={activeWorkLabel(activeThreads)}
            className={RAIL_CHIP_CLASS}
          >
            <span
              aria-hidden
              className="size-1.5 shrink-0 animate-pulse rounded-full bg-success"
            />
            Active
          </span>
        ) : null}
        {labels.length > 0 ? (
          <>
            <span className="hidden items-center gap-1.5 @xl:flex">
              <LabelChipRow labels={labels} maxVisible={2} />
            </span>
            <span className="flex items-center gap-1.5 @xl:hidden">
              <LabelChipRow labels={labels} maxVisible={1} />
            </span>
          </>
        ) : null}
        {project !== undefined ? (
          <span
            aria-hidden
            title={project.name}
            className="size-2.5 shrink-0 rounded-sm"
            style={{ backgroundColor: project.color }}
          />
        ) : null}
      </span>
    </div>
  );
});
