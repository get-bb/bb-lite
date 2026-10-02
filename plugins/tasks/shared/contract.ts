import { defineRpcContract } from "@bb/plugin";
import { z } from "zod";

export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
] as const;
export const TASK_PRIORITIES = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
] as const;
export const TASK_SORTS = ["manual", "priority"] as const;
export const LIVE_STATUSES = [
  "starting",
  "working",
  "idle",
  "completed",
  "failed",
] as const;
export const ENVIRONMENT_KINDS = ["project-default", "new-worktree"] as const;
export const PERMISSION_MODES = ["accept-edits", "auto", "full"] as const;
export const REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
] as const;
export const SERVICE_TIERS = ["default", "fast"] as const;

export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
export const PROJECT_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{0,9}$/;
export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;
export const TASK_CHANNELS = [
  "tasks:changed",
  "projects:changed",
  "comments:changed",
  "threads:changed",
] as const;

export function attachmentDownloadUrl(attachmentId: string): string {
  return `/api/v1/plugins/tasks/http/attachments/download?attachmentId=${encodeURIComponent(attachmentId)}`;
}

export function displayName(value: string): string {
  return value
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

const id = z.string().regex(ULID_PATTERN, "must be a ULID");
const text = z.string().trim().min(1, "must not be blank");
const threadId = z.string().startsWith("thr_");
const bbProjectId = z.string().startsWith("proj_");
const prefix = z
  .string()
  .regex(
    PROJECT_PREFIX_PATTERN,
    "must be uppercase alphanumeric, start with a letter, and contain at most 10 characters",
  );
const status = z.enum(TASK_STATUSES);
const priority = z.enum(TASK_PRIORITIES);
const liveStatus = z.enum(LIVE_STATUSES);
const labelIds = z.array(id).max(100);

const project = z.object({
  id,
  name: z.string(),
  prefix,
  nextTaskNumber: z.number().int().positive(),
  color: z.string(),
  folderId: z.string().nullable(),
  linkedBbProjectId: bbProjectId.nullable(),
  createdAt: z.string(),
});

const task = z.object({
  id,
  projectId: id,
  number: z.number().int().positive(),
  key: z.string(),
  title: z.string(),
  description: z.string(),
  status,
  priority,
  dueDate: z.string().nullable(),
  parentTaskId: id.nullable(),
  position: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  labelIds: z.array(id),
});

const label = z.object({
  id,
  projectId: id,
  name: z.string(),
  color: z.string(),
});

const commentProvider = z.object({ id: z.string(), name: z.string() });

const comment = z.object({
  id,
  taskId: id,
  kind: z.enum(["user", "agent", "system"]),
  authorName: z.string(),
  presetName: z.string().nullable(),
  threadId: threadId.nullable(),
  body: z.string(),
  notifiedCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});

const displayComment = comment.extend({
  threadTitle: z.string().nullable(),
  provider: commentProvider.nullable(),
});

const attachment = z.object({
  id,
  taskId: id.nullable(),
  commentId: id.nullable(),
  fileName: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  isImage: z.boolean(),
  createdAt: z.string(),
});

const taskThread = z.object({
  id,
  taskId: id,
  threadId,
  presetName: z.string(),
  title: z.string(),
  liveStatus,
  attachedAt: z.string(),
  updatedAt: z.string(),
});

const preset = z.object({
  id,
  name: z.string(),
  providerId: z.string(),
  modelId: z.string(),
  reasoningLevel: z.enum(REASONING_LEVELS),
  serviceTier: z.enum(SERVICE_TIERS).nullable(),
  permissionMode: z.enum(PERMISSION_MODES),
  environmentKind: z.enum(ENVIRONMENT_KINDS),
  baseBranch: z.string().nullable(),
  machineId: z.string().nullable(),
  instructions: z.string(),
  builtin: z.boolean(),
  createdAt: z.string(),
});

const taskDetail = z.object({
  task,
  project,
  parent: task.nullable(),
  subtasks: z.array(task),
  labels: z.array(label),
  attachments: z.array(attachment),
  commentAttachments: z.array(attachment),
  threads: z.array(taskThread),
  comments: z.array(displayComment),
});

export const taskFiltersSchema = z.object({
  projectId: id.optional(),
  statuses: z.array(status).optional(),
  priorities: z.array(priority).optional(),
  labelIds: z.array(id).optional(),
  activeOnly: z.boolean().default(false),
  parentTaskId: id.nullable().optional(),
  search: z.string().optional(),
  sort: z.enum(TASK_SORTS).default("manual"),
  limit: z.number().int().min(1).optional(),
});

export const createTaskInputSchema = z.object({
  projectId: id,
  title: text,
  description: z.string().default(""),
  status: status.default("backlog"),
  priority: priority.default("none"),
  parentTaskId: id.nullable().default(null),
  labelIds: labelIds.default([]),
});

export const updateTaskInputSchema = z.object({
  taskId: id,
  title: text.optional(),
  description: z.string().optional(),
  status: status.optional(),
  priority: priority.optional(),
  parentTaskId: id.nullable().optional(),
  labelIds: labelIds.optional(),
  authorName: text.default("You"),
});

export const tasksRpcContract = defineRpcContract({
  overview: {
    input: z.null(),
    output: z.object({
      projects: z.array(project),
      summaries: z.array(
        z.object({
          projectId: id,
          taskCount: z.number().int(),
          activeAgentCount: z.number().int(),
        }),
      ),
      activeTaskCount: z.number().int(),
      openTaskCount: z.number().int(),
    }),
  },
  createProject: {
    input: z.object({
      name: text,
      prefix,
      color: text,
      linkedBbProjectId: bbProjectId.nullable().default(null),
    }),
    output: z.object({ project }),
  },
  updateProject: {
    input: z.object({
      projectId: id,
      name: text.optional(),
      color: text.optional(),
      linkedBbProjectId: bbProjectId.nullable().optional(),
    }),
    output: z.object({ project }),
  },
  listBbProjects: {
    input: z.null(),
    output: z.object({
      bbProjects: z.array(z.object({ id: bbProjectId, name: z.string() })),
    }),
  },
  listTasks: {
    input: taskFiltersSchema,
    output: z.object({
      tasks: z.array(task),
      activeThreads: z.record(z.string(), z.array(liveStatus)),
    }),
  },
  getTaskByKey: {
    input: z.object({ taskKey: text }),
    output: z.object({ task: task.nullable() }),
  },
  taskDetail: {
    input: z.object({ taskKey: text }),
    output: z.object({ detail: taskDetail.nullable() }),
  },
  createTask: { input: createTaskInputSchema, output: z.object({ task }) },
  updateTask: { input: updateTaskInputSchema, output: z.object({ task }) },
  listLabels: {
    input: z.object({ projectId: id.optional() }),
    output: z.object({ labels: z.array(label) }),
  },
  createLabel: {
    input: z.object({ projectId: id, name: text, color: text }),
    output: z.object({ label }),
  },
  updateLabel: {
    input: z.object({
      labelId: id,
      name: text.optional(),
      color: text.optional(),
    }),
    output: z.object({ label }),
  },
  deleteLabel: {
    input: z.object({ labelId: id }),
    output: z.object({ deleted: z.boolean() }),
  },
  createComment: {
    input: z.object({ taskId: id, body: z.string(), notify: z.boolean() }),
    output: z.object({ comment }),
  },
  deleteAttachment: {
    input: z.object({ attachmentId: id }),
    output: z.object({ deleted: z.boolean() }),
  },
  listPresets: {
    input: z.null(),
    output: z.object({ presets: z.array(preset) }),
  },
  dispatch: {
    input: z.object({
      taskId: id,
      presetId: id,
      extraInstructions: z.string().optional(),
    }),
    output: z.object({ threadId }),
  },
  detachThread: {
    input: z.object({ taskId: id, threadId }),
    output: z.object({ threadId }),
  },
});

export type TasksRpcContract = typeof tasksRpcContract;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type TaskSort = (typeof TASK_SORTS)[number];
export type LiveStatus = (typeof LIVE_STATUSES)[number];
export type Project = z.infer<typeof project>;
export type Task = z.infer<typeof task>;
export type Label = z.infer<typeof label>;
export type Comment = z.infer<typeof comment>;
export type CommentProvider = z.infer<typeof commentProvider>;
export type DisplayComment = z.infer<typeof displayComment>;
export type Attachment = z.infer<typeof attachment>;
export type TaskThread = z.infer<typeof taskThread>;
export type Preset = z.infer<typeof preset>;
export type TaskDetail = z.infer<typeof taskDetail>;
export type TaskFilters = z.input<typeof taskFiltersSchema>;
export type CreateTaskInput = z.input<typeof createTaskInputSchema>;
export type UpdateTaskInput = z.input<typeof updateTaskInputSchema>;
export type Overview = z.infer<(typeof tasksRpcContract)["overview"]["output"]>;
