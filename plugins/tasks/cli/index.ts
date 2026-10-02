import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  cliCommand,
  defineCli,
  PluginCliError,
  type CliContext,
  type CliResult,
} from "@bb/plugin";
import {
  createComment,
  createTask,
  displayComments,
  errorMessage,
  updateTask,
  type TasksContext,
} from "../api/index.js";
import { readAttachment, saveAttachment } from "../attachments/index.js";
import { attachThread, detachThread, dispatch } from "../delegate/index.js";
import {
  attachmentDownloadUrl,
  createTaskInputSchema,
  PERMISSION_MODES,
  REASONING_LEVELS,
  TASK_PRIORITIES,
  TASK_SORTS,
  TASK_STATUSES,
  ULID_PATTERN,
  updateTaskInputSchema,
  type Preset,
  type Project,
  type Task,
} from "../shared/contract.js";

interface Extra {
  aliases?: readonly string[];
  required?: true;
  repeatable?: true;
  default?: string | number;
}
type None = Record<never, never>;
type Reply = [data: unknown, text: string];

const text = <const E extends Extra = None>(description: string, extra?: E) =>
  ({ type: "string", description, ...extra }) as {
    type: "string";
    description: string;
  } & E;
const choice = <
  const V extends readonly string[],
  const E extends Extra = None,
>(
  values: V,
  description: string,
  extra?: E,
) =>
  ({ type: "enum", values, description, ...extra }) as {
    type: "enum";
    values: V;
    description: string;
  } & E;
const flag = (description: string) =>
  ({ type: "boolean", description }) as const;

const STATUS = { name: "Tasks", version: "0.1.2" };
const JSON_FLAG = flag("Emit machine-readable JSON");
const PROJECT = text("Tracker project prefix or id such as ABC (not proj_...)");
const THREAD = text("Defaults to the invoking thread", {
  aliases: ["thread-id"],
});
const LISTS = "repeat or comma-separate";
const KEY = {
  name: "key-or-id",
  description: "Task key such as ABC-12 (case-insensitive) or its ULID",
  required: true,
} as const;
const PRESET = { ...KEY, name: "name", description: "Preset name or id" };
const TASK_FIELDS = {
  description: text("Markdown description; --description-stdin reads stdin", {
    aliases: ["body", "details", "text", "content"],
  }),
  status: choice(TASK_STATUSES, "Workflow status", { aliases: ["state"] }),
  priority: choice(TASK_PRIORITIES, "Task priority"),
  parent: text("Parent task key or id (one level of sub-tasks)"),
};

function fail(message: string, code?: string, hint?: string): never {
  throw new PluginCliError(message.replace(/\s+/gu, " "), { code, hint });
}

async function reply(
  json: boolean,
  action: () => Promise<Reply> | Reply,
): Promise<CliResult> {
  try {
    const [data, plain] = await action();
    return { exitCode: 0, stdout: json ? JSON.stringify(data) : plain };
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    return fail(errorMessage(error));
  }
}

function table<Row extends object>(
  rows: readonly Row[],
  keys: readonly (keyof Row & string)[],
): string {
  const heads = keys.map((key) => key.replace(/[A-Z].*$/u, "").toUpperCase());
  const cells = rows.map((row) =>
    keys.map((key) => String(row[key] ?? "-").replace(/\s+/gu, " ")),
  );
  const width = (column: number): number =>
    Math.max(...[heads, ...cells].map((row) => row[column]?.length ?? 0));
  const line = (row: string[]): string =>
    row.map((cell, column) => cell.padEnd(width(column))).join("  ");
  const lines = [heads, ...cells].map((row) => line(row).trimEnd());
  return rows.length === 0 ? "(none)" : lines.join("\n");
}

function split<T extends string>(
  values: readonly string[],
  allowed?: readonly T[],
): T[] | undefined {
  const items = values.flatMap((value) => value.split(",")).filter(Boolean);
  const isAllowed = (item: string): item is T =>
    allowed === undefined || allowed.some((entry) => entry === item);
  const known = items.filter(isAllowed);
  if (known.length < items.length) {
    fail(`expected one of ${allowed?.join(", ")}`, "usage");
  }
  return known.length > 0 ? known : undefined;
}

export function registerTasksCli(ctx: TasksContext): void {
  const { bb, store } = ctx;
  const author = (cli: CliContext): string =>
    cli.threadId ? `agent (${cli.threadId})` : "cli";

  function task(address: string): Task {
    const normalized = address.trim().toUpperCase();
    const found = ULID_PATTERN.test(normalized)
      ? store.getTask(normalized)
      : store.getTaskByKey(normalized);
    return found ?? fail(`task not found: ${address}`, "task_not_found");
  }

  function project(address: string | undefined, cli: CliContext): Project {
    const wanted = address?.trim().toUpperCase();
    const matches = store
      .listProjects()
      .filter((candidate) =>
        wanted === undefined
          ? candidate.linkedBbProjectId === cli.projectId
          : candidate.id === wanted || candidate.prefix === wanted,
      );
    if (matches.length === 1 && matches[0]) return matches[0];
    if (wanted) fail(`project not found: ${address}`, "project_not_found");
    return fail(
      "missing --project: this thread's bb project is not linked to exactly one tracker project",
      "missing_required",
      "run bb tasks project list to see tracker project prefixes",
    );
  }

  function labelIds(projectId: string, names: readonly string[]): string[] {
    const labels = store.listLabels(projectId);
    return (split(names) ?? []).map((name) => {
      const wanted = name.trim().toLowerCase();
      const label = labels.find(
        ({ id, name: labelName }) =>
          id.toLowerCase() === wanted || labelName.toLowerCase() === wanted,
      );
      return label?.id ?? fail(`label not found: ${name}`, "label_not_found");
    });
  }

  function preset(address: string): Preset | undefined {
    const wanted = address.trim().toLowerCase();
    return store.listPresets().find(({ id, name }) => {
      return id.toLowerCase() === wanted || name.toLowerCase() === wanted;
    });
  }

  const link = (verb: "attach" | "detach") =>
    cliCommand({
      summary: `${verb === "attach" ? "Attach" : "Detach"} an agent thread`,
      positionals: [KEY],
      options: { thread: THREAD, json: JSON_FLAG },
      run: ({ positionals, options }, cli) =>
        reply(options.json, async () => {
          const target = task(positionals["key-or-id"]);
          const threadId =
            options.thread ??
            cli.threadId ??
            fail("missing --thread outside a thread", "missing_required");
          if (verb === "attach") await attachThread(ctx, target.id, threadId);
          else detachThread(ctx, target.id, threadId);
          const done =
            verb === "attach"
              ? `Attached ${threadId} to ${target.key}`
              : `Detached ${threadId} from ${target.key}`;
          return [{ task: target, threadId }, done];
        }),
    });

  const commands = {
    status: cliCommand({
      summary: "Show the Tasks plugin name and version",
      options: { json: JSON_FLAG },
      run: ({ options }) =>
        reply(options.json, () => [STATUS, `${STATUS.name} ${STATUS.version}`]),
    }),
    "project list": cliCommand({
      summary: "List tracker projects",
      options: { json: JSON_FLAG },
      run: ({ options }) =>
        reply(options.json, () => {
          const projects = store.listProjects();
          const keys = ["prefix", "name", "linkedBbProjectId", "id"] as const;
          return [{ projects }, table(projects, keys)];
        }),
    }),
    create: cliCommand({
      summary: "Create a task",
      options: {
        project: PROJECT,
        title: text("Task title", {
          required: true,
          aliases: ["name", "subject"],
        }),
        ...TASK_FIELDS,
        label: text(`Existing label name; ${LISTS}`, {
          repeatable: true,
          aliases: ["labels"],
        }),
        json: JSON_FLAG,
      },
      run: ({ options }, cli) =>
        reply(options.json, () => {
          const { id: projectId } = project(options.project, cli);
          const { title, description, status, priority } = options;
          const input = createTaskInputSchema.parse({
            projectId,
            ...{ title, description, status, priority },
            parentTaskId: options.parent ? task(options.parent).id : null,
            labelIds: labelIds(projectId, options.label),
          });
          const created = createTask(ctx, input);
          const attachments = { attachments: [], failedAttachments: [] };
          const done = `Created ${created.key}  ${created.title}`;
          return [{ task: created, ...attachments }, done];
        }),
    }),
    list: cliCommand({
      summary: "List and filter tasks",
      options: {
        project: PROJECT,
        status: text(`Keep these statuses; ${LISTS}`, {
          repeatable: true,
          aliases: ["statuses", "state"],
        }),
        priority: text(`Keep these priorities; ${LISTS}`, {
          repeatable: true,
          aliases: ["priorities"],
        }),
        label: text(`Keep these labels (needs a project); ${LISTS}`, {
          repeatable: true,
          aliases: ["labels"],
        }),
        active: flag("Keep only tasks with a live agent thread"),
        search: text("Match key, title and description text", {
          aliases: ["query", "q"],
        }),
        sort: choice(TASK_SORTS, "Row order", { default: "manual" }),
        limit: { type: "integer", default: 100, description: "Maximum rows" },
        json: JSON_FLAG,
      },
      run: ({ options }, cli) =>
        reply(options.json, () => {
          const scoped = options.project !== undefined || cli.projectId;
          const scope = scoped ? project(options.project, cli) : undefined;
          const { limit, search, sort } = options;
          if (limit < 1) fail("--limit must be at least 1", "usage");
          const labelled = split(options.label) !== undefined;
          if (labelled && !scope) fail("--label needs --project", "usage");
          const names = new Map(
            store.listLabels().map((label) => [label.id, label.name]),
          );
          const active = store.activeThreadsByTask();
          const filters = {
            projectId: scope?.id,
            statuses: split(options.status, TASK_STATUSES),
            priorities: split(options.priority, TASK_PRIORITIES),
            labelIds:
              scope && labelled ? labelIds(scope.id, options.label) : undefined,
            activeOnly: options.active,
            ...{ search, sort, limit },
          };
          const tasks = store.listTasks(filters).map((entry) => ({
            ...entry,
            labels: entry.labelIds.map((id) => names.get(id) ?? id),
            agentsWorking: active[entry.id]?.length ?? 0,
          }));
          const keys = ["key", "status", "priority", "title"] as const;
          const rows = table(tasks, [...keys, "labels", "agentsWorking"]);
          return [{ tasks, nextCursor: null, limit }, rows];
        }),
    }),
    show: cliCommand({
      summary: "Show full task details",
      aliases: ["get"],
      positionals: [KEY],
      options: { json: JSON_FLAG },
      run: ({ positionals, options }) =>
        reply(options.json, async () => {
          const found = task(positionals["key-or-id"]);
          const owner = store.getProject(found.projectId);
          const labels = store
            .listLabels(found.projectId)
            .filter((label) => found.labelIds.includes(label.id));
          const subtasks = store.listTasks({ parentTaskId: found.id });
          const attachments = store
            .listAttachments("all", found.id)
            .map(({ blobPath: _blobPath, ...attachment }) => attachment);
          const taskThreads = store.listTaskThreads(found.id);
          const comments = await displayComments(ctx, found.id);
          const detail = { task: found, project: owner, labels, subtasks };
          const said = comments.map((comment) => {
            const who = comment.threadTitle ?? comment.authorName;
            const head = `--- ${comment.createdAt} · ${comment.kind} · ${who}`;
            return `${head}\n${comment.body}`;
          });
          const tags = labels.map((label) => label.name).join(", ") || "-";
          const plain = [
            `${found.key} — ${found.title}\n${found.status} · ${found.priority} priority · labels: ${tags} · id: ${found.id}`,
            `Description\n${found.description || "(none)"}`,
            `Sub-tasks\n${table(subtasks, ["key", "status", "title"])}`,
            `Attachments\n${table(attachments, ["id", "fileName", "sizeBytes"])}`,
            `Threads\n${table(taskThreads, ["threadId", "liveStatus", "title"])}`,
            `Comments\n${said.join("\n\n") || "(none)"}`,
          ];
          const activity = { attachments, taskThreads, comments };
          return [{ ...detail, ...activity }, plain.join("\n\n")];
        }),
    }),
    update: cliCommand({
      summary: "Update task fields and labels",
      positionals: [KEY],
      options: {
        title: text("New title", { aliases: ["name", "subject"] }),
        ...TASK_FIELDS,
        "no-parent": flag("Promote the task to the top level"),
        "add-label": text(`Label to add; ${LISTS}`, { repeatable: true }),
        "remove-label": text(`Label to remove; ${LISTS}`, {
          repeatable: true,
        }),
        json: JSON_FLAG,
      },
      run: ({ positionals, options }, cli) =>
        reply(options.json, () => {
          const current = task(positionals["key-or-id"]);
          const removed = labelIds(current.projectId, options["remove-label"]);
          const added = labelIds(current.projectId, options["add-label"]);
          const kept = current.labelIds.filter((id) => !removed.includes(id));
          const relabel = removed.length + added.length > 0;
          const parent = options.parent ? task(options.parent).id : undefined;
          const { title, description, status, priority } = options;
          const changes = {
            ...{ title, description, status, priority },
            parentTaskId: options["no-parent"] ? null : parent,
            labelIds: relabel ? [...new Set([...kept, ...added])] : undefined,
          };
          if (Object.values(changes).every((value) => value === undefined)) {
            fail("no task changes were provided", "no_changes");
          }
          const identity = { taskId: current.id, authorName: author(cli) };
          const input = { ...changes, ...identity };
          const updated = updateTask(ctx, updateTaskInputSchema.parse(input));
          return [
            { task: updated },
            `Updated ${updated.key}  ${updated.title}`,
          ];
        }),
    }),
    comment: cliCommand({
      summary: "Add a markdown comment to a task",
      positionals: [KEY],
      options: {
        body: text("Comment markdown; --body-stdin reads it from stdin", {
          aliases: ["message", "text", "content"],
        }),
        author: text("Display name; defaults to the invoking thread or cli"),
        notify: flag(
          "Deliver the comment to the thread of the task's latest agent reply",
        ),
        json: JSON_FLAG,
      },
      run: ({ positionals, options }, cli) =>
        reply(options.json, async () => {
          const target = task(positionals["key-or-id"]);
          const { body, notify } = options;
          if (!body?.trim()) fail("missing --body", "missing_required");
          const comment = await createComment(ctx, {
            taskId: target.id,
            kind: cli.threadId ? "agent" : "user",
            authorName: options.author ?? author(cli),
            threadId: cli.threadId ?? null,
            ...{ body, notify },
          });
          return [{ comment }, `Commented on ${target.key}  ${comment.id}`];
        }),
    }),
    attach: link("attach"),
    detach: link("detach"),
    threads: cliCommand({
      summary: "List agent threads attached to a task",
      positionals: [KEY],
      options: { json: JSON_FLAG },
      run: ({ positionals, options }) =>
        reply(options.json, () => {
          const target = task(positionals["key-or-id"]);
          const taskThreads = store.listTaskThreads(target.id);
          const keys = [
            "threadId",
            "liveStatus",
            "presetName",
            "title",
          ] as const;
          return [{ task: target, taskThreads }, table(taskThreads, keys)];
        }),
    }),
    "attachment add": cliCommand({
      summary: "Attach a file to a task or comment",
      description:
        "The file is read on the invoking thread's machine, else the server's.",
      positionals: [{ ...KEY, name: "key-or-comment-id" }],
      options: {
        file: text("Source file to upload, at most 25 MB", {
          required: true,
          aliases: ["path", "attach"],
        }),
        name: text("Stored file name; defaults to the source basename"),
        json: JSON_FLAG,
      },
      run: ({ positionals, options }, cli) =>
        reply(options.json, async () => {
          const address = positionals["key-or-comment-id"];
          const comment = store.getComment(address.trim().toUpperCase());
          const owner = comment
            ? { taskId: null, commentId: comment.id }
            : { taskId: task(address).id, commentId: null };
          const path = resolve(cli.cwd ?? process.cwd(), options.file);
          const { threadId } = cli;
          const encoding = "base64";
          const content =
            threadId === undefined
              ? await readFile(path, encoding).catch(() => null)
              : (await bb.files.read({ threadId, path, encoding }))?.content;
          if (content == null)
            fail(`file not found: ${path}`, "file_not_found");
          const bytes = Buffer.from(content, encoding);
          const name = options.name ?? options.file;
          const attachment = await saveAttachment(ctx, owner, name, bytes);
          const url = attachmentDownloadUrl(attachment.id);
          const done = `Added attachment ${attachment.fileName}  ${attachment.id}`;
          return [{ attachment, url }, done];
        }),
    }),
    "attachment get": cliCommand({
      summary: "Download an attachment to a path",
      description:
        "The file is written on the invoking thread's machine, else the server's.",
      positionals: [
        { ...KEY, name: "attachment-id", description: "Attachment ULID" },
      ],
      options: {
        out: text("Destination path", {
          required: true,
          aliases: ["output", "to"],
        }),
        json: JSON_FLAG,
      },
      run: ({ positionals, options }, cli) =>
        reply(options.json, async () => {
          const id = positionals["attachment-id"].trim().toUpperCase();
          const { attachment, content } =
            (await readAttachment(ctx, id)) ??
            fail(`attachment not found: ${id}`, "attachment_not_found");
          const out = resolve(cli.cwd ?? process.cwd(), options.out);
          const { threadId } = cli;
          if (threadId === undefined) {
            await mkdir(dirname(out), { recursive: true });
            await writeFile(out, content);
          } else {
            const file = { content: content.toString("base64"), path: out };
            await bb.files.write({ threadId, encoding: "base64", ...file });
          }
          return [{ attachment, out }, `Saved ${attachment.fileName}  ${out}`];
        }),
    }),
    dispatch: cliCommand({
      summary: "Dispatch a task to a new agent thread",
      aliases: ["delegate"],
      positionals: [KEY],
      options: {
        preset: text("Preset name or id; see bb tasks preset list", {
          required: true,
        }),
        instructions: text("Extra instructions for this dispatch only", {
          aliases: ["extra-instructions"],
        }),
        json: JSON_FLAG,
      },
      run: ({ positionals, options }) =>
        reply(options.json, async () => {
          const target = task(positionals["key-or-id"]);
          const chosen =
            preset(options.preset) ??
            fail(`preset not found: ${options.preset}`, "preset_not_found");
          const { threadId } = await dispatch(ctx, {
            taskId: target.id,
            presetId: chosen.id,
            extraInstructions: options.instructions,
          });
          return [{ task: target, preset: chosen, threadId }, threadId];
        }),
    }),
    "preset list": cliCommand({
      summary: "List dispatch presets",
      options: { json: JSON_FLAG },
      run: ({ options }) =>
        reply(options.json, () => {
          const presets = store.listPresets();
          const keys = ["name", "providerId", "modelId", "id"] as const;
          return [{ presets }, table(presets, keys)];
        }),
    }),
    "preset set": cliCommand({
      summary: "Create a dispatch preset, or update the one with this name",
      positionals: [PRESET],
      options: {
        provider: text("Provider id such as codex or claude-code"),
        model: text("Model id as the provider spells it"),
        reasoning: choice(REASONING_LEVELS, "Reasoning level"),
        permission: choice(PERMISSION_MODES, "Permission mode"),
        "service-tier": choice(["default", "fast", "none"], "none clears it"),
        environment: choice(["project-default", "worktree"], "Where it runs"),
        "base-branch": text("Branch new worktrees start from"),
        machine: text("Machine id that hosts the worktree"),
        instructions: text("Instructions added to every dispatch"),
        delete: flag("Delete the preset instead"),
        json: JSON_FLAG,
      },
      run: ({ positionals, options }) =>
        reply(options.json, () => {
          const base = preset(positionals.name);
          if (options.delete) {
            const deleted = base !== undefined && store.deletePreset(base.id);
            return [{ deleted, preset: base }, `Deleted: ${deleted}`];
          }
          const providerId = options.provider ?? base?.providerId;
          const modelId = options.model ?? base?.modelId;
          const reasoningLevel = options.reasoning ?? base?.reasoningLevel;
          const permissionMode = options.permission ?? base?.permissionMode;
          if (!providerId || !modelId || !reasoningLevel || !permissionMode) {
            const flags = "--provider, --model, --reasoning and --permission";
            return fail(`a new preset needs ${flags}`, "missing_required");
          }
          const tier = options["service-tier"];
          const worktree =
            options.environment === undefined
              ? base?.environmentKind === "new-worktree"
              : options.environment === "worktree";
          const branch = options["base-branch"] ?? base?.baseBranch ?? null;
          const machine = options.machine ?? base?.machineId ?? null;
          const fields = {
            name: base?.name ?? positionals.name,
            ...{ providerId, modelId, reasoningLevel, permissionMode },
            serviceTier:
              tier === "none" ? null : (tier ?? base?.serviceTier ?? null),
            environmentKind: worktree
              ? ("new-worktree" as const)
              : ("project-default" as const),
            baseBranch: worktree ? branch : null,
            machineId: worktree ? machine : null,
            instructions: options.instructions ?? base?.instructions ?? "",
          };
          const saved = store.savePreset(fields, base?.id);
          return [{ preset: saved }, `Saved preset ${saved.name}  ${saved.id}`];
        }),
    }),
  };

  const summary = "Create and manage tracker tasks, comments and attachments";
  bb.cli.register(defineCli({ name: "tasks", summary, commands }));
}
