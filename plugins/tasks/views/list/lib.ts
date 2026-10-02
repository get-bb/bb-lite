import {
  TASK_PRIORITIES,
  TASK_SORTS,
  TASK_STATUSES,
  type Label,
  type Task,
  type TaskPriority,
  type TaskSort,
  type TaskStatus,
} from "../../shared/contract.js";

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "No priority",
};

export const SORT_LABELS: Record<TaskSort, string> = {
  manual: "Manual",
  priority: "Priority",
};

export function groupTasksByStatus(tasks: readonly Task[]) {
  return TASK_STATUSES.flatMap((status) => {
    const group = tasks.filter((task) => task.status === status);
    return group.length > 0 ? [{ status, tasks: group }] : [];
  });
}

export interface LabelFilterOption {
  name: string;
  color: string;
  labelIds: string[];
}

export function labelFilterOptions(
  labels: readonly Label[],
): LabelFilterOption[] {
  const byName = new Map<string, LabelFilterOption>();
  for (const { id, name, color } of labels) {
    const option = byName.get(name) ?? { name, color, labelIds: [] };
    option.labelIds.push(id);
    byName.set(name, option);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function activeWorkLabel(statuses: readonly string[]): string {
  if (statuses.length !== 1) return `${statuses.length} agents working`;
  return statuses[0] === "starting" ? "Agent starting" : "Agent working";
}

export interface ListPreference {
  statuses: TaskStatus[];
  priorities: TaskPriority[];
  labelNames: string[];
  sort: TaskSort;
}

export const EMPTY_FILTERS = { statuses: [], priorities: [], labelNames: [] };
const STORAGE_KEY = "bb-tasks:list-preferences";

function known<T extends string>(allowed: readonly T[], values: unknown): T[] {
  const list: unknown[] = Array.isArray(values) ? values : [];
  return allowed.filter((entry) => list.includes(entry));
}

function readScopes(): Record<string, Partial<ListPreference>> {
  try {
    const stored: unknown = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "{}",
    );
    return typeof stored === "object" && stored !== null ? { ...stored } : {};
  } catch {
    return {};
  }
}

export function loadListPreference(scope: string): ListPreference {
  const stored = readScopes()[scope] ?? {};
  const names: unknown[] = Array.isArray(stored.labelNames)
    ? stored.labelNames
    : [];
  return {
    statuses: known(TASK_STATUSES, stored.statuses),
    priorities: known(TASK_PRIORITIES, stored.priorities),
    labelNames: names.filter((name) => typeof name === "string"),
    sort: known(TASK_SORTS, [stored.sort])[0] ?? "manual",
  };
}

export function storeListPreference(
  scope: string,
  preference: ListPreference,
): void {
  try {
    const scopes = { ...readScopes(), [scope]: preference };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(scopes));
  } catch {}
}
