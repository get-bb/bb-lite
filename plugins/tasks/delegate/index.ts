import { machines, threads, type PluginServerApi } from "@bb/plugin";
import type { z } from "zod";
import {
  errorMessage,
  taskBrief,
  publish,
  requireTask,
  type TasksContext,
} from "../api/index.js";
import type { LiveStatus, Preset, TaskThread } from "../shared/contract.js";

type CreateThread = z.input<(typeof threads)["create"]["input"]>;
type Thread = NonNullable<z.output<(typeof threads)["get"]["output"]>>;

const TITLE_MAX_CHARACTERS = 120;
const SYSTEM_AUTHOR = "Tasks";
export const MANUAL_PRESET_NAME = "Attached";

const clip = (title: string): string =>
  [...title].slice(0, TITLE_MAX_CHARACTERS).join("");

function liveStatusOf(thread: Pick<Thread, "status" | "deletedAt">) {
  if (thread.status === "error") return "failed";
  if (thread.deletedAt !== null) return "completed";
  if (thread.status === "idle") return "idle";
  const running = thread.status === "active" || thread.status === "stopping";
  return running ? "working" : "starting";
}

async function spawnEnvironment(
  bb: PluginServerApi,
  preset: Preset,
): Promise<CreateThread["environment"]> {
  if (preset.environmentKind === "project-default") {
    return { type: "project-default" };
  }
  const hosts = await bb.call(machines.list, {});
  const oldest = [...hosts].sort((a, b) => a.createdAt - b.createdAt)[0];
  const hostId = preset.machineId ?? oldest?.id;
  if (hostId === undefined) {
    throw new Error("Could not create a worktree because BB has no machine");
  }
  const baseBranch =
    preset.baseBranch === null
      ? { kind: "default" as const }
      : { kind: "named" as const, name: preset.baseBranch };
  const workspace = { type: "managed-worktree" as const, baseBranch };
  return { type: "host", hostId, workspace };
}

export async function dispatch(
  ctx: TasksContext,
  input: { taskId: string; presetId: string; extraInstructions?: string },
): Promise<{ threadId: string }> {
  const { bb, store } = ctx;
  const { taskId } = input;
  const task = requireTask(store, taskId);
  const project = store.getProject(task.projectId);
  if (!project?.linkedBbProjectId) {
    const name = project?.name ?? task.projectId;
    throw new Error(`Task project "${name}" is not linked to a bb project`);
  }
  const preset = store
    .listPresets()
    .find((candidate) => candidate.id === input.presetId);
  if (!preset) throw new Error(`Preset not found: ${input.presetId}`);
  const title = clip(`${task.key} · ${task.title}`);
  const { key } = task;
  const contract = `You are working on task ${key}. Use the bb tasks CLI: comment substantive updates (bb tasks comment ${key} --body ...), attach result artifacts, set status when done (bb tasks update ${key} --status in_review) or explain blockage in a comment. Your thread is already attached to the task.`;
  const text = taskBrief(ctx, task, [
    ["Report-back contract", contract],
    ["Preset instructions", preset.instructions],
    ["Additional instructions", input.extraInstructions ?? ""],
  ]);
  const thread = await bb.call(threads.create, {
    origin: "plugin",
    originPluginId: bb.pluginId,
    startedOnBehalfOf: null,
    projectId: project.linkedBbProjectId,
    environment: await spawnEnvironment(bb, preset),
    providerId: preset.providerId,
    model: preset.modelId,
    reasoningLevel: preset.reasoningLevel,
    ...(preset.serviceTier === null ? {} : { serviceTier: preset.serviceTier }),
    permissionMode: preset.permissionMode,
    title,
    input: [{ type: "text", text, mentions: [] }],
  });
  const { id: threadId } = thread;
  const presetName = preset.name;
  store.transaction(() => {
    const liveStatus = liveStatusOf(thread);
    store.upsertTaskThread({ taskId, threadId, presetName, title, liveStatus });
    const note = (body: string) => {
      const author = { kind: "system" as const, authorName: SYSTEM_AUTHOR };
      store.createComment({ taskId, ...author, presetName, threadId, body });
    };
    if (task.status === "backlog" || task.status === "todo") {
      store.updateTask(taskId, { status: "in_progress" });
      note(`Status changed to In Progress · dispatched to ${presetName}`);
    }
    note(`Dispatched to ${presetName}`);
  });
  publish(ctx, "threads", "tasks", "comments");
  return { threadId };
}

export async function attachThread(
  ctx: TasksContext,
  taskId: string,
  threadId: string,
): Promise<void> {
  const task = requireTask(ctx.store, taskId);
  const thread = await ctx.bb.call(threads.get, { threadId });
  const fallback = `${task.key} · ${task.title}`;
  ctx.store.upsertTaskThread({
    taskId,
    threadId,
    presetName: MANUAL_PRESET_NAME,
    title: clip(thread.title ?? thread.titleFallback ?? fallback),
    liveStatus: liveStatusOf(thread),
  });
  publish(ctx, "threads", "tasks");
}

export function detachThread(
  ctx: TasksContext,
  taskId: string,
  threadId: string,
): { threadId: string } {
  const task = requireTask(ctx.store, taskId);
  if (!ctx.store.deleteTaskThread(taskId, threadId)) {
    throw new Error(`Thread ${threadId} is not attached to ${task.key}`);
  }
  publish(ctx, "threads", "tasks");
  return { threadId };
}

function transition(
  ctx: TasksContext,
  link: TaskThread,
  liveStatus: LiveStatus,
  announce = true,
): void {
  const { store } = ctx;
  if (link.liveStatus === liveStatus || link.liveStatus === "completed") return;
  const { taskId, presetName, threadId } = link;
  const ended = liveStatus === "completed" || liveStatus === "failed";
  store.transaction(() => {
    store.setLiveStatus(link.id, liveStatus);
    if (!ended || !announce) return;
    const outcome =
      liveStatus === "completed"
        ? "completed — final message posted"
        : "failed";
    const body = `Thread "${link.title}" ${outcome} · ${threadId}`;
    const author = { kind: "system" as const, authorName: SYSTEM_AUTHOR };
    store.createComment({ taskId, ...author, presetName, threadId, body });
  });
  publish(ctx, "threads", "comments");
}

export async function registerLifecycle(ctx: TasksContext): Promise<void> {
  const { bb, store } = ctx;
  const follow = (thread: Thread, liveStatus: LiveStatus): void => {
    for (const link of store.listThreadLinks(thread.id)) {
      transition(ctx, link, liveStatus);
    }
  };
  bb.on(threads.created, ({ thread }) => follow(thread, liveStatusOf(thread)));
  bb.on(threads.active, ({ thread }) => follow(thread, "working"));
  bb.on(threads.idle, ({ thread }) => follow(thread, "idle"));
  bb.on(threads.failed, ({ thread }) => follow(thread, "failed"));
  bb.on(threads.deleted, ({ thread }) => follow(thread, "completed"));
  for (const link of store.listOpenThreadLinks()) {
    try {
      const { threadId } = link;
      const thread = await bb.call(threads.get, { threadId }).catch(() => null);
      if (thread === null) transition(ctx, link, "completed", false);
      else transition(ctx, link, liveStatusOf(thread));
    } catch (error) {
      const reason = errorMessage(error);
      bb.log.warn(`Could not reconcile thread ${link.threadId}: ${reason}`);
    }
  }
}
