import { fail, threads, type PluginServerApi } from "@bb/plugin";
import type { z } from "zod";
import type { TasksStore } from "../db/store.js";
import {
  displayName,
  type Comment,
  type createTaskInputSchema,
  type DisplayComment,
  type Task,
  type TaskDetail,
  TASK_CHANGES,
  type TaskChange,
  type updateTaskInputSchema,
} from "../shared/contract.js";

export interface TasksContext {
  bb: PluginServerApi;
  store: TasksStore;
}

interface NewComment {
  taskId: string;
  kind: Comment["kind"];
  authorName: string;
  threadId: string | null;
  body: string;
  notify: boolean;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function listed<T>(items: readonly T[], line: (item: T) => string): string {
  return items.length === 0 ? "None." : items.map(line).join("\n");
}

export function taskBrief(
  { store }: TasksContext,
  task: Task,
  closing: [title: string, body: string][],
): string {
  const project = store.getProject(task.projectId);
  const labels = store
    .listLabels(task.projectId)
    .filter((label) => task.labelIds.includes(label.id))
    .map((label) => label.name);
  const details = [
    `- Status: ${displayName(task.status)}`,
    `- Priority: ${displayName(task.priority)}`,
    `- Labels: ${labels.join(", ") || "None"}`,
    `- Project: ${project?.name ?? task.projectId}`,
    `- Linked bb project: ${project?.linkedBbProjectId ?? "Not linked"}`,
  ];
  const sections: [title: string, body: string][] = [
    ["Task details", details.join("\n")],
    ["Description", task.description || "No description provided."],
    [
      "Sub-tasks",
      listed(
        store.listTasks({ parentTaskId: task.id }),
        ({ key, title, status }) => `- ${key} · ${title} (${status})`,
      ),
    ],
    [
      "Attachments",
      listed(
        store.listAttachments("all", task.id),
        ({ id, fileName }) =>
          `- ${fileName} · ${id}\n  Fetch with: bb tasks attachment get ${id} --out <path>`,
      ),
    ],
    [
      "Recent comments",
      listed(
        store.listComments(task.id).slice(-5),
        ({ authorName, kind, createdAt, body }) =>
          `### ${authorName} · ${kind} · ${createdAt}\n\n${body}\n`,
      ),
    ],
    [
      "Attached threads",
      listed(
        store.listTaskThreads(task.id),
        ({ threadId, title, liveStatus }) =>
          `- ${threadId} · ${title} · ${liveStatus}`,
      ),
    ],
    ...closing,
  ];
  const body = sections
    .filter(([, text]) => text.trim() !== "")
    .map(([title, text]) => `## ${title}\n\n${text.trim()}`);
  return `${[`# ${task.key} · ${task.title}`, ...body].join("\n\n")}\n`;
}

export function publish({ bb }: TasksContext, ...changes: TaskChange[]): void {
  const ops = new Set(changes.map((change) => TASK_CHANGES[change]));
  for (const changed of ops) bb.changed(changed);
}

export function requireTask(store: TasksStore, taskId: string): Task {
  const task = store.getTask(taskId);
  if (!task)
    fail("not_found", `Task not found: ${taskId}`, {
      reason: "task_not_found",
    });
  return task;
}

function checkParent(
  store: TasksStore,
  projectId: string,
  parentTaskId: string | null,
  ownId?: string,
): void {
  if (parentTaskId === null) return;
  if (parentTaskId === ownId) {
    fail("invalid", "A task cannot be its own parent");
  }
  const parent = requireTask(store, parentTaskId);
  if (parent.projectId !== projectId) {
    fail("invalid", "A sub-task must belong to the same project as its parent");
  }
  if (parent.parentTaskId !== null) {
    fail("invalid", "Tasks support at most one level of sub-tasks");
  }
  if (ownId && store.listTasks({ parentTaskId: ownId }).length > 0) {
    fail("invalid", "A task with sub-tasks cannot itself become a sub-task");
  }
}

function checkLabels(
  store: TasksStore,
  projectId: string,
  labelIds: readonly string[],
): void {
  for (const labelId of labelIds) {
    if (store.getLabel(labelId)?.projectId !== projectId) {
      fail(
        "invalid",
        `Task labels must belong to the task project: ${labelId}`,
      );
    }
  }
}

export function createTask(
  ctx: TasksContext,
  { projectId, ...fields }: z.output<typeof createTaskInputSchema>,
): Task {
  checkParent(ctx.store, projectId, fields.parentTaskId);
  checkLabels(ctx.store, projectId, fields.labelIds);
  const task = ctx.store.createTask(projectId, fields);
  publish(ctx, "tasks");
  return task;
}

export function updateTask(
  ctx: TasksContext,
  { taskId, authorName, ...patch }: z.output<typeof updateTaskInputSchema>,
): Task {
  const { store } = ctx;
  const current = requireTask(store, taskId);
  const parentTaskId = patch.parentTaskId ?? null;
  if (patch.parentTaskId !== undefined) {
    checkParent(store, current.projectId, parentTaskId, taskId);
  }
  if (patch.labelIds) checkLabels(store, current.projectId, patch.labelIds);
  const notes: string[] = [];
  const task = store.transaction(() => {
    const updated = store.updateTask(taskId, patch);
    for (const field of ["status", "priority"] as const) {
      if (updated[field] === current[field]) continue;
      const value = displayName(updated[field]);
      notes.push(`${displayName(field)} changed to ${value} by ${authorName}`);
    }
    if (updated.labelIds.join() !== current.labelIds.join()) {
      const names = store
        .listLabels(updated.projectId)
        .filter((label) => updated.labelIds.includes(label.id))
        .map((label) => label.name);
      notes.push(
        names.length === 0
          ? `Labels cleared by ${authorName}`
          : `Labels changed to ${names.join(", ")} by ${authorName}`,
      );
    }
    for (const body of notes) {
      store.createComment({ taskId, kind: "system", authorName, body });
    }
    return updated;
  });
  publish(ctx, "tasks");
  if (notes.length > 0) publish(ctx, "comments");
  return task;
}

async function notifyLatestAgent(
  { bb, store }: TasksContext,
  comment: Comment,
): Promise<number> {
  const threadId = store.latestAgentThreadId(comment.taskId, comment.id);
  if (threadId === null) return 0;
  const { key } = requireTask(store, comment.taskId);
  const text =
    `New comment on task ${key} from ${comment.authorName}: ${comment.body}` +
    "\n\nTreat this as updated context for your work on this task; " +
    `reply via bb tasks comment ${key} when relevant.`;
  try {
    const input = [{ type: "text" as const, text, mentions: [] }];
    const mode = "steer-if-active" as const;
    await bb.call(threads.send, { threadId, input, mode });
    return 1;
  } catch (error) {
    const reason = errorMessage(error);
    bb.log.warn(
      `comment ${comment.id} not delivered to ${threadId}: ${reason}`,
    );
    return 0;
  }
}

export async function createComment(
  ctx: TasksContext,
  { notify, ...input }: NewComment,
): Promise<Comment> {
  requireTask(ctx.store, input.taskId);
  const comment = ctx.store.createComment(input);
  if (notify) {
    comment.notifiedCount = await notifyLatestAgent(ctx, comment);
    ctx.store.setNotifiedCount(comment.id, comment.notifiedCount);
  }
  publish(ctx, "comments");
  return comment;
}

export async function displayComments(
  { bb, store }: TasksContext,
  taskId: string,
): Promise<DisplayComment[]> {
  const comments = store.listComments(taskId);
  const authors = comments.flatMap((comment) =>
    comment.kind === "agent" && comment.threadId ? [comment.threadId] : [],
  );
  const authored = new Map(
    await Promise.all(
      [...new Set(authors)].map(async (threadId) => {
        const thread = await bb
          .call(threads.get, { threadId })
          .catch(() => null);
        return [threadId, thread] as const;
      }),
    ),
  );
  return comments.map((comment) => {
    const thread =
      comment.kind === "agent" ? authored.get(comment.threadId ?? "") : null;
    if (!thread) return { ...comment, threadTitle: null, provider: null };
    const title = thread.title?.trim() || thread.titleFallback?.trim() || null;
    const provider = { id: thread.providerId, name: thread.providerId };
    return { ...comment, threadTitle: title, provider };
  });
}

export async function taskDetail(
  ctx: TasksContext,
  task: Task,
): Promise<TaskDetail> {
  const { store } = ctx;
  const project = store.getProject(task.projectId);
  if (!project) fail("not_found", `Project not found: ${task.projectId}`);
  return {
    task,
    project,
    parent: task.parentTaskId
      ? (store.getTask(task.parentTaskId) ?? null)
      : null,
    subtasks: store
      .listTasks({ parentTaskId: task.id })
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
    labels: store.listLabels(task.projectId),
    attachments: store.listAttachments("task", task.id),
    commentAttachments: store.listAttachments("comments", task.id),
    threads: store.listTaskThreads(task.id),
    comments: await displayComments(ctx, task.id),
  };
}
