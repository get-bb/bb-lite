import { useState, type ReactNode } from "react";
import type {
  Label,
  Preset,
  Project,
  Task,
  TaskThread,
  UpdateTaskInput,
} from "../../shared/contract.js";
import { reportError, useTasksQuery, useTasksRpc } from "../../shell/data.js";
import { PriorityEditor, StatusEditor } from "../list/property-menus.js";
import { BbProjectLinkPicker, DEFAULT_COLOR } from "../manage/shared.js";
import { DispatchControl, isActiveThread } from "./threads.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@bb/shared-ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

export type TaskPropertyUpdate = Pick<
  UpdateTaskInput,
  "status" | "priority" | "labelIds"
>;

export function LabelPicker({
  projectId,
  labels,
  selectedIds,
  onChange,
  children,
}: {
  projectId: string | undefined;
  labels: Label[] | undefined;
  selectedIds: readonly string[];
  onChange: (labelIds: string[]) => void;
  children: ReactNode;
}) {
  const rpc = useTasksRpc();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const name = query.trim();
  const toggle = (labelId: string) =>
    onChange(
      selectedIds.includes(labelId)
        ? selectedIds.filter((id) => id !== labelId)
        : [...selectedIds, labelId],
    );
  const create = () => {
    if (!name || creating || projectId === undefined) return;
    setCreating(true);
    rpc
      .call("createLabel", { projectId, name, color: DEFAULT_COLOR })
      .then(({ label }) => {
        onChange([...selectedIds, label.id]);
        setQuery("");
      }, reportError)
      .finally(() => setCreating(false));
  };
  return (
    <Popover onOpenChange={(open) => open || setQuery("")}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput
            placeholder="Add labels…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty className={name !== "" ? "p-1 text-left" : undefined}>
              {name !== "" ? (
                <button
                  type="button"
                  disabled={creating}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                  onClick={create}
                >
                  <Icon name="Plus" className="size-3.5" />
                  Create “{name}”
                </button>
              ) : (
                "No labels in this project."
              )}
            </CommandEmpty>
            {labels !== undefined && labels.length > 0 ? (
              <CommandGroup>
                {labels.map((label) => (
                  <CommandItem
                    key={label.id}
                    value={label.name}
                    onSelect={() => toggle(label.id)}
                  >
                    <span
                      aria-hidden
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: label.color }}
                    />
                    <span className="flex-1">{label.name}</span>
                    {selectedIds.includes(label.id) ? (
                      <Icon name="Check" className="size-3.5" />
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function DispatchTarget({ project }: { project: Project }) {
  const rpc = useTasksRpc();
  const bbProjects = useTasksQuery(
    async (client) => (await client.call("listBbProjects")).bbProjects,
  );
  return (
    <BbProjectLinkPicker
      value={project.linkedBbProjectId}
      bbProjects={bbProjects.data ?? []}
      onChange={(linkedBbProjectId) => {
        const input = { projectId: project.id, linkedBbProjectId };
        rpc.call("updateProject", input).catch(reportError);
      }}
    />
  );
}

const RAIL_ROW_CLASS =
  "-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-state-hover";
const CHIP_CLASS =
  "inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-0.5 text-xs text-foreground hover:border-input";
const HEADING_CLASS = "mb-1 mt-3 text-2xs font-semibold text-muted-foreground";
export function TaskProperties({
  variant,
  task,
  project,
  labels,
  threads,
  presets,
  onUpdate,
  className,
}: {
  variant: "rail" | "inline";
  task: Task;
  project: Project;
  labels: Label[];
  threads: TaskThread[];
  presets: Preset[] | undefined;
  onUpdate: (update: TaskPropertyUpdate) => void;
  className?: string;
}) {
  const rail = variant === "rail";
  const trigger = rail ? RAIL_ROW_CLASS : CHIP_CLASS;
  const active = threads.filter(isActiveThread);
  const swatch = (
    <span
      aria-hidden
      className="size-3 shrink-0 rounded-sm"
      style={{ backgroundColor: project.color }}
    />
  );
  const status = (
    <StatusEditor
      labelled
      value={task.status}
      onSelect={(next) => onUpdate({ status: next })}
      className={trigger}
    />
  );
  const priority = (
    <PriorityEditor
      labelled
      value={task.priority}
      onSelect={(next) => onUpdate({ priority: next })}
      className={trigger}
    />
  );
  const labelChips = labels
    .filter((label) => task.labelIds.includes(label.id))
    .map((label) => (
      <span
        key={label.id}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-0.5 text-2xs text-muted-foreground"
      >
        <span
          aria-hidden
          className="size-1.5 rounded-full"
          style={{ backgroundColor: label.color }}
        />
        {label.name}
      </span>
    ));
  const labelPicker = (
    <LabelPicker
      projectId={task.projectId}
      labels={labels}
      selectedIds={task.labelIds}
      onChange={(labelIds) => onUpdate({ labelIds })}
    >
      <button
        type="button"
        aria-label="Edit labels"
        className={`inline-flex items-center rounded-md border border-dashed border-border ${rail ? "px-1.5 py-0.5" : "px-2 py-1"} text-muted-foreground hover:border-input hover:text-foreground`}
      >
        <Icon name="Plus" className="size-3" />
      </button>
    </LabelPicker>
  );

  if (!rail) {
    return (
      <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
        <span className={CHIP_CLASS}>
          {swatch}
          <span className="truncate">{project.name}</span>
        </span>
        {status}
        {priority}
        {labelChips}
        {labelPicker}
        <DispatchControl
          taskId={task.id}
          presets={presets}
          className="ml-auto max-w-56"
        />
      </div>
    );
  }
  return (
    <aside className={cn("w-56 shrink-0 py-10 pl-2 pr-6", className)}>
      <h2 className="mb-1.5 text-xs font-semibold text-muted-foreground">
        Properties
      </h2>
      {status}
      {priority}
      <div className={HEADING_CLASS}>Labels</div>
      <div className="flex flex-wrap items-center gap-1 py-0.5">
        {labelChips}
        {labelPicker}
      </div>
      <div className={HEADING_CLASS}>Project</div>
      <div className="flex items-center gap-2 py-1 text-sm">
        {swatch}
        <span className="truncate">{project.name}</span>
      </div>
      <div className={HEADING_CLASS}>Dispatch target</div>
      <DispatchTarget project={project} />
      <div className="mt-2.5 py-0.5">
        <DispatchControl
          taskId={task.id}
          presets={presets}
          align="start"
          className="w-full"
        />
      </div>
      <div className={HEADING_CLASS}>Agents</div>
      <div className="flex flex-col gap-1 py-0.5 text-xs">
        {active.map((thread) => (
          <span
            key={thread.id}
            className="flex items-center gap-1.5 font-medium text-success"
          >
            <span
              aria-hidden
              className="size-1.5 shrink-0 animate-pulse rounded-full bg-success"
            />
            <span className="truncate">
              {thread.presetName}{" "}
              {thread.liveStatus === "starting" ? "starting" : "working"}
            </span>
          </span>
        ))}
        {active.length === 0 ? (
          <span className="text-muted-foreground">none active</span>
        ) : null}
      </div>
    </aside>
  );
}
