import { sessions } from "@bb/plugin";
import { taskBrief, type TasksContext } from "../api/index.js";
import { displayName, type Task } from "../shared/contract.js";

const SEARCH_LIMIT = 10;

export function registerMentions(ctx: TasksContext): void {
  const { bb, store } = ctx;
  bb.add(sessions.mention, {
    id: "task",
    label: "Tasks",
    search({ query, projectId }) {
      const projects = new Map(
        store.listProjects().map((project) => [project.id, project]),
      );
      const linked = (task: Task): number =>
        projects.get(task.projectId)?.linkedBbProjectId === projectId ? 0 : 1;
      const needle = query.trim().toLowerCase();
      return store
        .listTasks()
        .filter((task) =>
          `${task.key} ${task.title}`.toLowerCase().includes(needle),
        )
        .sort(
          (a, b) =>
            linked(a) - linked(b) || b.updatedAt.localeCompare(a.updatedAt),
        )
        .slice(0, SEARCH_LIMIT)
        .map((task) => ({
          id: task.id,
          title: `${task.key} · ${task.title}`,
          subtitle: `${projects.get(task.projectId)?.name} · ${displayName(task.status)}`,
        }));
    },
    resolve(itemId) {
      const task = store.getTask(itemId);
      if (!task) throw new Error(`Task not found: ${itemId}`);
      const contract = `You can act on this task with the bb tasks CLI. If you begin working on it, first run: bb tasks attach ${task.key} (attaches THIS thread so the task shows you as working). Comment substantive updates via bb tasks comment ${task.key} --body ... and set status via bb tasks update ${task.key} --status ...`;
      return { context: taskBrief(ctx, task, [["Action contract", contract]]) };
    },
  });
}
