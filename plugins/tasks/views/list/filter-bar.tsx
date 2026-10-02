import type { ReactNode } from "react";
import {
  TASK_PRIORITIES,
  TASK_SORTS,
  TASK_STATUSES,
} from "../../shared/contract.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { PriorityIcon, StatusIcon } from "./icons.js";
import {
  EMPTY_FILTERS,
  PRIORITY_LABELS,
  SORT_LABELS,
  STATUS_LABELS,
  type LabelFilterOption,
  type ListPreference,
} from "./lib.js";

function chipTriggerClass(active: boolean): string {
  return cn(
    "flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs",
    active
      ? "border-border bg-secondary text-foreground"
      : "border-dashed border-border text-muted-foreground hover:border-input hover:text-foreground",
  );
}

function FilterChip<Value extends string>({
  icon,
  label,
  align = "start",
  selected,
  options,
  onToggle,
}: {
  icon: IconName;
  label: string;
  align?: "start" | "end";
  selected: readonly Value[];
  options: readonly { value: Value; name: string; mark?: ReactNode }[];
  onToggle: (value: Value, checked: boolean) => void;
}) {
  const names = options
    .filter((option) => selected.includes(option.value))
    .map((option) => option.name);
  const sorting = align === "end";
  const active = sorting ? selected[0] !== "manual" : names.length > 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={chipTriggerClass(active)}>
          <Icon name={icon} className="size-3" />
          {label}
          {active ? (
            <span
              className={
                sorting
                  ? "font-medium"
                  : "max-w-48 truncate font-medium @max-md:max-w-24"
              }
            >
              {names.join(", ")}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-44">
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={selected.includes(option.value)}
            onSelect={
              sorting ? undefined : (event: Event) => event.preventDefault()
            }
            onCheckedChange={(checked) =>
              onToggle(option.value, checked === true)
            }
          >
            {option.mark === undefined ? (
              option.name
            ) : (
              <span className="flex items-center gap-2">
                {option.mark}
                {option.name}
              </span>
            )}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function toggled<T>(values: readonly T[], value: T, checked: boolean): T[] {
  const rest = values.filter((existing) => existing !== value);
  return checked ? [...rest, value] : rest;
}

export function ListFilterBar({
  preference,
  onChange,
  labelOptions,
  taskCount,
}: {
  preference: ListPreference;
  onChange: (patch: Partial<ListPreference>) => void;
  labelOptions: readonly LabelFilterOption[];
  taskCount: number | undefined;
}) {
  const { statuses, priorities, labelNames, sort } = preference;
  const filtered = statuses.length + priorities.length + labelNames.length > 0;
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border-hairline px-3.5 py-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        <FilterChip
          icon="Circle"
          label="Status"
          selected={statuses}
          options={TASK_STATUSES.map((value) => ({
            value,
            name: STATUS_LABELS[value],
            mark: <StatusIcon status={value} className="size-3" />,
          }))}
          onToggle={(value, checked) =>
            onChange({ statuses: toggled(statuses, value, checked) })
          }
        />
        <FilterChip
          icon="ArrowUpDown"
          label="Priority"
          selected={priorities}
          options={TASK_PRIORITIES.map((value) => ({
            value,
            name: PRIORITY_LABELS[value],
            mark: <PriorityIcon priority={value} className="size-3" />,
          }))}
          onToggle={(value, checked) =>
            onChange({ priorities: toggled(priorities, value, checked) })
          }
        />
        {labelOptions.length > 0 || labelNames.length > 0 ? (
          <FilterChip
            icon="ListTodo"
            label="Label"
            selected={labelNames}
            options={labelOptions.map((option) => ({
              value: option.name,
              name: option.name,
              mark: (
                <span
                  aria-hidden
                  className="size-2 rounded-full"
                  style={{ backgroundColor: option.color }}
                />
              ),
            }))}
            onToggle={(value, checked) =>
              onChange({ labelNames: toggled(labelNames, value, checked) })
            }
          />
        ) : null}
        {filtered ? (
          <button
            type="button"
            onClick={() => onChange(EMPTY_FILTERS)}
            className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-dashed border-border px-2.5 text-xs text-muted-foreground hover:border-input hover:text-foreground"
          >
            <Icon name="X" className="size-3" />
            Clear
          </button>
        ) : null}
      </div>
      <FilterChip
        icon="Sort"
        label="Sort"
        align="end"
        selected={[sort]}
        options={TASK_SORTS.map((value) => ({
          value,
          name: SORT_LABELS[value],
        }))}
        onToggle={(value, checked) => {
          if (checked) onChange({ sort: value });
        }}
      />
      <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-subtle-foreground">
        {taskCount === undefined
          ? ""
          : `${taskCount} ${taskCount === 1 ? "task" : "tasks"}`}
      </span>
    </div>
  );
}
