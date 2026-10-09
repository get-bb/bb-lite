import { fail, OpError, projects } from "@bb/plugin";
import { deleteAttachment } from "../attachments/index.js";
import { detachThread, dispatch } from "../delegate/index.js";
import { tasks } from "../shared/contract.js";
import {
  createComment,
  createTask,
  publish,
  taskDetail,
  updateTask,
  type TasksContext,
} from "./index.js";

function explained(error: unknown): unknown {
  const plain = error instanceof Error && error.constructor === Error;
  return plain ? new OpError("invalid_input", error.message) : error;
}

export function registerTasksOps(ctx: TasksContext): void {
  const { bb, store } = ctx;
  const implement: typeof bb.implement = (op, run) =>
    bb.implement(op, async (input, context) => {
      try {
        return await run(input, context);
      } catch (error) {
        throw explained(error);
      }
    });
  const projectsChanged = (): void => publish(ctx, "projects");
  const uniquePrefix = (prefix: string): void => {
    const taken = store
      .listProjects()
      .some((project) => project.prefix.toUpperCase() === prefix.toUpperCase());
    if (taken) fail("conflict", `Project prefix is already in use: ${prefix}`);
  };
  const uniqueLabel = (projectId: string, name: string, id?: string): void => {
    const wanted = name.toLowerCase();
    const taken = store
      .listLabels(projectId)
      .some((label) => label.id !== id && label.name.toLowerCase() === wanted);
    if (taken) fail("conflict", `Label already exists: ${name}`);
  };
  implement(tasks.overview, () => ({
    projects: store.listProjects(),
    summaries: store.summaries(),
    activeTaskCount: store.activeTaskCount(),
    openTaskCount: store.openTaskCount(),
  }));
  implement(tasks.createProject, (input) => {
    uniquePrefix(input.prefix);
    const project = store.createProject(input);
    projectsChanged();
    return { project };
  });
  implement(tasks.updateProject, ({ projectId, ...patch }) => {
    const project = store.updateProject(projectId, patch);
    projectsChanged();
    return { project };
  });
  implement(tasks.listBbProjects, async () => {
    const listed = await bb.call(projects.list, {});
    return { bbProjects: listed.map(({ id, name }) => ({ id, name })) };
  });
  implement(tasks.listTasks, (input) => ({
    tasks: store.listTasks(input),
    activeThreads: store.activeThreadsByTask(),
  }));
  implement(tasks.getTaskByKey, ({ taskKey }) => ({
    task: store.getTaskByKey(taskKey) ?? null,
  }));
  implement(tasks.taskDetail, async ({ taskKey }) => {
    const task = store.getTaskByKey(taskKey);
    return { detail: task ? await taskDetail(ctx, task) : null };
  });
  implement(tasks.createTask, (input) => ({
    task: createTask(ctx, input),
  }));
  implement(tasks.updateTask, (input) => ({
    task: updateTask(ctx, input),
  }));
  implement(tasks.listLabels, ({ projectId }) => ({
    labels: store.listLabels(projectId),
  }));
  implement(tasks.createLabel, (input) => {
    uniqueLabel(input.projectId, input.name);
    const label = store.createLabel(input);
    projectsChanged();
    return { label };
  });
  implement(tasks.updateLabel, ({ labelId, ...patch }) => {
    const current = store.getLabel(labelId);
    if (current && patch.name !== undefined) {
      uniqueLabel(current.projectId, patch.name, labelId);
    }
    const label = store.updateLabel(labelId, patch);
    projectsChanged();
    return { label };
  });
  implement(tasks.deleteLabel, ({ labelId }) => {
    const deleted = store.deleteLabel(labelId);
    if (deleted) projectsChanged();
    return { deleted };
  });
  implement(tasks.createComment, async (input) => {
    const author = { kind: "user" as const, authorName: "You" };
    const comment = { ...input, ...author, threadId: null };
    return { comment: await createComment(ctx, comment) };
  });
  implement(tasks.deleteAttachment, async ({ attachmentId }) => ({
    deleted: await deleteAttachment(ctx, attachmentId),
  }));
  implement(tasks.listPresets, () => ({ presets: store.listPresets() }));
  implement(tasks.dispatch, (input) => dispatch(ctx, input));
  implement(tasks.detachThread, ({ taskId, threadId }) =>
    detachThread(ctx, taskId, threadId),
  );
}
