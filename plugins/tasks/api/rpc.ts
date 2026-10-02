import type { RpcHandlers } from "@bb/plugin";
import { deleteAttachment } from "../attachments/index.js";
import { detachThread, dispatch } from "../delegate/index.js";
import { tasksRpcContract } from "../shared/contract.js";
import {
  createComment,
  createTask,
  taskDetail,
  updateTask,
  type TasksContext,
} from "./index.js";

export function registerTasksRpc(ctx: TasksContext): void {
  const { bb, store } = ctx;
  const projectsChanged = (projectId: string | null): void =>
    bb.realtime.publish("projects:changed", { projectId });
  const handlers: RpcHandlers<typeof tasksRpcContract> = {
    overview: () => ({
      projects: store.listProjects(),
      summaries: store.summaries(),
      activeTaskCount: store.activeTaskCount(),
      openTaskCount: store.openTaskCount(),
    }),
    createProject(input) {
      const project = store.createProject(input);
      projectsChanged(project.id);
      return { project };
    },
    updateProject({ projectId, ...patch }) {
      const project = store.updateProject(projectId, patch);
      projectsChanged(projectId);
      return { project };
    },
    async listBbProjects() {
      const projects = await bb.projects.list();
      return { bbProjects: projects.map(({ id, name }) => ({ id, name })) };
    },
    listTasks: (input) => ({
      tasks: store.listTasks(input),
      activeThreads: store.activeThreadsByTask(),
    }),
    getTaskByKey: ({ taskKey }) => ({
      task: store.getTaskByKey(taskKey) ?? null,
    }),
    async taskDetail({ taskKey }) {
      const task = store.getTaskByKey(taskKey);
      return { detail: task ? await taskDetail(ctx, task) : null };
    },
    createTask: (input) => ({ task: createTask(ctx, input) }),
    updateTask: (input) => ({ task: updateTask(ctx, input) }),
    listLabels: ({ projectId }) => ({ labels: store.listLabels(projectId) }),
    createLabel(input) {
      const label = store.createLabel(input);
      projectsChanged(label.projectId);
      return { label };
    },
    updateLabel({ labelId, ...patch }) {
      const label = store.updateLabel(labelId, patch);
      projectsChanged(label.projectId);
      return { label };
    },
    deleteLabel({ labelId }) {
      const deleted = store.deleteLabel(labelId);
      if (deleted) projectsChanged(null);
      return { deleted };
    },
    async createComment(input) {
      const author = { kind: "user" as const, authorName: "You" };
      const comment = { ...input, ...author, threadId: null };
      return { comment: await createComment(ctx, comment) };
    },
    deleteAttachment: async ({ attachmentId }) => ({
      deleted: await deleteAttachment(ctx, attachmentId),
    }),
    listPresets: () => ({ presets: store.listPresets() }),
    dispatch: (input) => dispatch(ctx, input),
    detachThread: ({ taskId, threadId }) => detachThread(ctx, taskId, threadId),
  };
  bb.rpc.register(tasksRpcContract, handlers);
}
