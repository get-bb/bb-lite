import { fail } from "@bb/plugin";
import { randomBytes } from "node:crypto";
import type {
  Attachment,
  Comment,
  Label,
  LiveStatus,
  Overview,
  Preset,
  Project,
  Task,
  TaskPriority,
  TaskSort,
  TaskStatus,
  TaskThread,
} from "../shared/contract.js";
import { initializeTasksSchema, type PluginDatabase } from "./schema.js";

type Param = string | number | null;
type TaskRow = Omit<Task, "labelIds"> & { labelIds: string };
type AttachmentRow = Omit<StoredAttachment, "isImage"> & { isImage: number };
type PresetRow = Omit<Preset, "builtin"> & { builtin: number };
export type StoredAttachment = Attachment & { blobPath: string };
export type PresetInput = Omit<Preset, "id" | "builtin" | "createdAt">;

export interface TaskQuery {
  projectId?: string;
  statuses?: readonly TaskStatus[];
  priorities?: readonly TaskPriority[];
  labelIds?: readonly string[];
  activeOnly?: boolean;
  parentTaskId?: string | null;
  search?: string;
  sort?: TaskSort;
  limit?: number;
}

interface TaskFields {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  parentTaskId: string | null;
  labelIds: string[];
}

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const POSITION_STEP = 1_024;
const ACTIVE = "live_status IN ('starting', 'working')";
const PROJECT = `id, name, prefix, next_task_number AS nextTaskNumber, color,
  folder_id AS folderId, linked_bb_project_id AS linkedBbProjectId,
  created_at AS createdAt`;
const TASK = `SELECT t.id, t.project_id AS projectId, t.number,
  p.prefix || '-' || t.number AS key, t.title, t.description, t.status,
  t.priority, t.due_date AS dueDate, t.parent_task_id AS parentTaskId,
  t.position, t.created_at AS createdAt, t.updated_at AS updatedAt,
  (SELECT json_group_array(label_id) FROM
    (SELECT label_id FROM task_labels WHERE task_id = t.id ORDER BY label_id)
  ) AS labelIds
  FROM tasks t JOIN projects p ON p.id = t.project_id`;
const LABEL = "id, project_id AS projectId, name, color";
const COMMENT = `id, task_id AS taskId, kind, author_name AS authorName,
  preset_name AS presetName, thread_id AS threadId, body,
  notified_count AS notifiedCount, created_at AS createdAt`;
const ATTACHMENT = `SELECT a.id, a.task_id AS taskId,
  a.comment_id AS commentId, a.file_name AS fileName, a.mime,
  a.size_bytes AS sizeBytes, a.blob_path AS blobPath, a.is_image AS isImage,
  a.created_at AS createdAt
  FROM attachments a LEFT JOIN comments c ON c.id = a.comment_id`;
const THREAD = `id, task_id AS taskId, thread_id AS threadId,
  preset_name AS presetName, title, live_status AS liveStatus,
  attached_at AS attachedAt, updated_at AS updatedAt`;
const PRESET = `id, name, provider_id AS providerId, model_id AS modelId,
  reasoning_level AS reasoningLevel, service_tier AS serviceTier,
  permission_mode AS permissionMode, environment_kind AS environmentKind,
  base_branch AS baseBranch, machine_id AS machineId, instructions, builtin,
  created_at AS createdAt`;
const PRIORITY_RANK = `CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
  WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
const ATTACHMENT_SCOPES = {
  task: "a.task_id",
  comments: "c.task_id",
  all: "COALESCE(a.task_id, c.task_id)",
};

let lastUlidMs = -1;
let lastUlidRandom = 0n;

function createUlid(now = Date.now()): string {
  let random = lastUlidRandom + 1n;
  if (now !== lastUlidMs) {
    random = 0n;
    for (const byte of randomBytes(10)) random = (random << 8n) | BigInt(byte);
  }
  lastUlidMs = now;
  lastUlidRandom = random;
  let value = (BigInt(now) << 80n) | random;
  let id = "";
  for (let index = 0; index < 26; index += 1) {
    id = ULID_ALPHABET[Number(value & 31n)] + id;
    value >>= 5n;
  }
  return id;
}

const nowIso = (): string => new Date().toISOString();

function found<T>(value: T | undefined, what: string): T {
  if (value === undefined) fail("not_found", `${what} not found`);
  return value;
}

function merged<T extends object>(current: T, patch: NoInfer<Partial<T>>): T {
  const next = { ...current };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const value = patch[key];
    if (value !== undefined) next[key] = value;
  }
  return next;
}

function snakeCase(key: string): string {
  return key.replace(/[A-Z]/gu, (char) => `_${char.toLowerCase()}`);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (char) => `\\${char}`);
}

export function createTasksStore(db: PluginDatabase) {
  initializeTasksSchema(db);
  const all = <Row>(sql: string, ...params: Param[]): Row[] =>
    db.prepare<Param[], Row>(sql).all(...params);
  const get = <Row>(sql: string, ...params: Param[]): Row | undefined =>
    db.prepare<Param[], Row>(sql).get(...params);
  const run = (sql: string, ...params: Param[]): number =>
    db.prepare<Param[]>(sql).run(...params).changes;
  const count = (sql: string): number =>
    get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${sql}`)?.count ?? 0;
  const insert = (table: string, row: Record<string, Param>, tail = "") => {
    const marks = Object.keys(row).map(() => "?");
    const columns = `(${Object.keys(row).map(snakeCase).join(", ")})`;
    const sql = `INSERT INTO ${table} ${columns} VALUES (${marks.join(", ")})`;
    run(`${sql} ${tail}`, ...Object.values(row));
  };
  const update = (table: string, id: string, row: Record<string, Param>) => {
    const sets = Object.keys(row).map((key) => `${snakeCase(key)} = ?`);
    const sql = `UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`;
    return run(sql, ...Object.values(row), id);
  };

  const listProjects = (): Project[] =>
    all(`SELECT ${PROJECT} FROM projects ORDER BY name COLLATE NOCASE, id`);
  const getProject = (id: string): Project | undefined =>
    get(`SELECT ${PROJECT} FROM projects WHERE id = ?`, id);

  function createProject(
    input: Pick<Project, "name" | "prefix" | "color" | "linkedBbProjectId">,
  ): Project {
    const { name, prefix, color, linkedBbProjectId } = input;
    const row = { id: createUlid(), name, prefix, color, linkedBbProjectId };
    insert("projects", { ...row, createdAt: nowIso() });
    return found(getProject(row.id), "Project");
  }

  function updateProject(
    id: string,
    patch: Partial<Pick<Project, "name" | "color" | "linkedBbProjectId">>,
  ): Project {
    const next = merged(found(getProject(id), `Project ${id}`), patch);
    const { name, color, linkedBbProjectId } = next;
    update("projects", id, { name, color, linkedBbProjectId });
    return next;
  }

  const taskFromRow = (row: TaskRow | undefined): Task | undefined =>
    row && { ...row, labelIds: JSON.parse(row.labelIds) as string[] };
  const getTask = (id: string): Task | undefined =>
    taskFromRow(get(`${TASK} WHERE t.id = ?`, id));

  function getTaskByKey(key: string): Task | undefined {
    const [, prefix, number] =
      /^([A-Za-z][A-Za-z0-9]{0,9})-(\d+)$/u.exec(key.trim()) ?? [];
    if (prefix === undefined) return undefined;
    const where = "WHERE p.prefix = ? COLLATE NOCASE AND t.number = ?";
    return taskFromRow(get(`${TASK} ${where}`, prefix, Number(number)));
  }

  function listTasks(query: TaskQuery = {}): Task[] {
    const where: string[] = [];
    const params: Param[] = [];
    const within = (
      clause: (list: string) => string,
      values: readonly string[] | undefined,
    ): void => {
      if (values === undefined) return;
      where.push(clause(values.map(() => "?").join(", ") || "NULL"));
      params.push(...values);
    };
    const equals = (column: string, value: string | undefined): void => {
      if (value === undefined) return;
      where.push(`${column} = ?`);
      params.push(value);
    };
    equals("t.project_id", query.projectId);
    within((list) => `t.status IN (${list})`, query.statuses);
    within((list) => `t.priority IN (${list})`, query.priorities);
    within(
      (list) => `EXISTS (SELECT 1 FROM task_labels tl
        WHERE tl.task_id = t.id AND tl.label_id IN (${list}))`,
      query.labelIds,
    );
    if (query.activeOnly) {
      where.push(`EXISTS (SELECT 1 FROM task_threads tt
        WHERE tt.task_id = t.id AND tt.${ACTIVE})`);
    }
    if (query.parentTaskId === null) where.push("t.parent_task_id IS NULL");
    else equals("t.parent_task_id", query.parentTaskId);
    for (const term of query.search?.split(/\s+/u).filter(Boolean) ?? []) {
      where.push(`(t.title || char(10) || t.description || char(10) ||
        p.prefix || '-' || t.number) LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(term)}%`);
    }
    const manual = "t.project_id, t.status, t.position, t.id";
    const order =
      query.sort === "priority" ? `${PRIORITY_RANK}, ${manual}` : manual;
    const limit = query.limit === undefined ? "" : `LIMIT ${query.limit}`;
    const filter = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return all<TaskRow>(
      `${TASK} ${filter} ORDER BY ${order} ${limit}`,
      ...params,
    ).flatMap((row) => taskFromRow(row) ?? []);
  }

  function nextPosition(projectId: string, status: TaskStatus): number {
    const row = get<{ position: number }>(
      `SELECT COALESCE(MAX(position), 0) + ${POSITION_STEP} AS position
       FROM tasks WHERE project_id = ? AND status = ?`,
      projectId,
      status,
    );
    return row?.position ?? POSITION_STEP;
  }

  function setTaskLabels(taskId: string, labelIds: readonly string[]): void {
    run("DELETE FROM task_labels WHERE task_id = ?", taskId);
    for (const labelId of new Set(labelIds)) {
      run("INSERT INTO task_labels VALUES (?, ?)", taskId, labelId);
    }
  }

  const createTask = db.transaction(
    (projectId: string, { labelIds, ...fields }: TaskFields): Task => {
      const project = found(getProject(projectId), `Project ${projectId}`);
      const { nextTaskNumber: number } = project;
      const id = createUlid();
      const position = nextPosition(projectId, fields.status);
      const stamps = { createdAt: nowIso(), updatedAt: nowIso() };
      update("projects", projectId, { nextTaskNumber: number + 1 });
      const identity = { id, projectId, number, position };
      insert("tasks", { ...identity, ...fields, ...stamps });
      setTaskLabels(id, labelIds);
      return found(getTask(id), "Task");
    },
  );

  const updateTask = db.transaction(
    (id: string, patch: Partial<TaskFields>): Task => {
      const current = found(getTask(id), `Task ${id}`);
      const next = merged(current, patch);
      const { title, description, status, priority, parentTaskId } = next;
      const position =
        status === current.status
          ? current.position
          : nextPosition(current.projectId, status);
      const fields = { title, description, status, priority, parentTaskId };
      update("tasks", id, { ...fields, position, updatedAt: nowIso() });
      if (patch.labelIds !== undefined) setTaskLabels(id, patch.labelIds);
      return found(getTask(id), "Task");
    },
  );

  const listLabels = (projectId?: string): Label[] =>
    all(
      `SELECT ${LABEL} FROM labels WHERE project_id = COALESCE(?, project_id)
       ORDER BY name COLLATE NOCASE, id`,
      projectId ?? null,
    );
  const getLabel = (id: string): Label | undefined =>
    get(`SELECT ${LABEL} FROM labels WHERE id = ?`, id);

  function createLabel({ projectId, name, color }: Omit<Label, "id">): Label {
    const label = { id: createUlid(), projectId, name, color };
    insert("labels", label);
    return label;
  }

  function updateLabel(
    id: string,
    patch: Partial<Pick<Label, "name" | "color">>,
  ): Label {
    const next = merged(found(getLabel(id), `Label ${id}`), patch);
    update("labels", id, { name: next.name, color: next.color });
    return next;
  }

  const getComment = (id: string): Comment | undefined =>
    get(`SELECT ${COMMENT} FROM comments WHERE id = ?`, id);
  const listComments = (taskId: string): Comment[] =>
    all(
      `SELECT ${COMMENT} FROM comments WHERE task_id = ?
       ORDER BY created_at, rowid`,
      taskId,
    );

  function createComment(
    input: Pick<Comment, "taskId" | "kind" | "authorName" | "body"> &
      Partial<Pick<Comment, "presetName" | "threadId">>,
  ): Comment {
    const { taskId, kind, authorName, body } = input;
    const { presetName = null, threadId = null } = input;
    const row = { id: createUlid(), taskId, kind, authorName, presetName };
    insert("comments", { ...row, threadId, body, createdAt: nowIso() });
    return found(getComment(row.id), "Comment");
  }

  const latestAgentThreadId = (
    taskId: string,
    exceptCommentId: string,
  ): string | null =>
    get<{ threadId: string | null }>(
      `SELECT thread_id AS threadId FROM comments
       WHERE task_id = ? AND kind = 'agent' AND id <> ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      taskId,
      exceptCommentId,
    )?.threadId ?? null;

  const attachmentFromRow = (row: AttachmentRow): StoredAttachment => ({
    ...row,
    isImage: row.isImage === 1,
  });
  const listAttachments = (
    scope: keyof typeof ATTACHMENT_SCOPES,
    taskId: string,
  ): StoredAttachment[] =>
    all<AttachmentRow>(
      `${ATTACHMENT} WHERE ${ATTACHMENT_SCOPES[scope]} = ?
       ORDER BY a.created_at, a.id`,
      taskId,
    ).map(attachmentFromRow);

  function getAttachment(id: string): StoredAttachment | undefined {
    const row = get<AttachmentRow>(`${ATTACHMENT} WHERE a.id = ?`, id);
    return row && attachmentFromRow(row);
  }

  function createAttachment(
    input: Omit<StoredAttachment, "id" | "createdAt">,
  ): StoredAttachment {
    const { taskId, commentId, fileName, mime, sizeBytes, blobPath } = input;
    const owner = { id: createUlid(), taskId, commentId };
    const file = { fileName, mime, sizeBytes, blobPath };
    const isImage = input.isImage ? 1 : 0;
    insert("attachments", { ...owner, ...file, isImage, createdAt: nowIso() });
    return found(getAttachment(owner.id), "Attachment");
  }

  const taskThreads = (where: string, ...params: Param[]): TaskThread[] =>
    all(`SELECT ${THREAD} FROM task_threads WHERE ${where}`, ...params);

  function upsertTaskThread(
    input: Omit<TaskThread, "id" | "attachedAt" | "updatedAt">,
  ): void {
    const { taskId, threadId, presetName, title, liveStatus } = input;
    const link = { id: createUlid(), taskId, threadId, presetName, title };
    const stamps = { attachedAt: nowIso(), updatedAt: nowIso() };
    insert(
      "task_threads",
      { ...link, liveStatus, ...stamps },
      `ON CONFLICT (task_id, thread_id) DO UPDATE SET
        preset_name = excluded.preset_name, title = excluded.title,
        live_status = excluded.live_status, updated_at = excluded.updated_at`,
    );
  }

  const presetFromRow = (row: PresetRow): Preset => ({
    ...row,
    builtin: row.builtin === 1,
  });
  const listPresets = (): Preset[] =>
    all<PresetRow>(
      `SELECT ${PRESET} FROM presets
       ORDER BY builtin DESC, name COLLATE NOCASE, id`,
    ).map(presetFromRow);

  function savePreset(input: PresetInput, existingId?: string): Preset {
    const { name, providerId, modelId, reasoningLevel, serviceTier } = input;
    const { permissionMode, environmentKind, baseBranch, machineId } = input;
    const execution = { providerId, modelId, reasoningLevel, serviceTier };
    const target = { permissionMode, environmentKind, baseBranch, machineId };
    const fields = { name, ...execution, ...target };
    const row = { ...fields, instructions: input.instructions };
    const id = existingId ?? createUlid();
    if (existingId !== undefined) update("presets", id, row);
    else insert("presets", { id, ...row, createdAt: nowIso() });
    const saved = listPresets().find((preset) => preset.id === id);
    return found(saved, "Preset");
  }

  function activeThreadsByTask(): Record<string, LiveStatus[]> {
    const byTask: Record<string, LiveStatus[]> = {};
    for (const { taskId, liveStatus } of taskThreads(ACTIVE)) {
      (byTask[taskId] ??= []).push(liveStatus);
    }
    return byTask;
  }

  const summaries = (): Overview["summaries"] =>
    all(
      `SELECT p.id AS projectId, COUNT(DISTINCT t.id) AS taskCount,
        COUNT(DISTINCT CASE WHEN tt.${ACTIVE} THEN tt.thread_id END)
          AS activeAgentCount
       FROM projects p
       LEFT JOIN tasks t ON t.project_id = p.id AND t.parent_task_id IS NULL
       LEFT JOIN task_threads tt ON tt.task_id = t.id
       GROUP BY p.id ORDER BY p.name COLLATE NOCASE, p.id`,
    );

  return {
    transaction: <T>(work: () => T): T => db.transaction(work)(),
    listProjects,
    getProject,
    createProject,
    updateProject,
    getTask,
    getTaskByKey,
    listTasks,
    createTask,
    updateTask,
    listLabels,
    getLabel,
    createLabel,
    updateLabel,
    deleteLabel: (id: string) => run("DELETE FROM labels WHERE id = ?", id) > 0,
    getComment,
    listComments,
    createComment,
    latestAgentThreadId,
    setNotifiedCount: (id: string, notifiedCount: number) =>
      update("comments", id, { notifiedCount }),
    listAttachments,
    getAttachment,
    createAttachment,
    setBlobPath: (id: string, blobPath: string) =>
      update("attachments", id, { blobPath }),
    deleteAttachment: (id: string) =>
      run("DELETE FROM attachments WHERE id = ?", id) > 0,
    upsertTaskThread,
    listTaskThreads: (taskId: string) =>
      taskThreads(
        `task_id = ? ORDER BY live_status IN ('completed', 'failed'),
         attached_at DESC, id DESC`,
        taskId,
      ),
    listThreadLinks: (threadId: string) =>
      taskThreads("thread_id = ? ORDER BY task_id, id", threadId),
    listOpenThreadLinks: () => taskThreads("live_status <> 'completed'"),
    setLiveStatus: (id: string, liveStatus: LiveStatus) =>
      update("task_threads", id, { liveStatus, updatedAt: nowIso() }),
    deleteTaskThread: (taskId: string, threadId: string) =>
      run(
        "DELETE FROM task_threads WHERE task_id = ? AND thread_id = ?",
        taskId,
        threadId,
      ) > 0,
    listPresets,
    savePreset,
    deletePreset: (id: string) =>
      run("DELETE FROM presets WHERE id = ?", id) > 0,
    activeThreadsByTask,
    summaries,
    openTaskCount: () =>
      count("tasks WHERE status NOT IN ('done', 'canceled')"),
    activeTaskCount: () =>
      count(`(SELECT DISTINCT task_id FROM task_threads WHERE ${ACTIVE})`),
  };
}

export type TasksStore = ReturnType<typeof createTasksStore>;
