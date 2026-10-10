import { callOp } from "@bb/plugin/app";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  tasks,
  type Preset,
  type Task,
  type TaskDetail,
  type UpdateTaskInput,
} from "../../shared/contract.js";
import { reportError, usePresets, useTasksQuery } from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { MarkdownField } from "../../editor/markdown.js";
import { StatusIcon } from "../list/icons.js";
import { STATUS_LABELS } from "../list/lib.js";
import { TaskActivity } from "./activity.js";
import { AttachmentsGrid, uploadAttachment } from "./attachments.js";
import { TaskProperties } from "./rail.js";
import { ThreadsSection } from "./threads.js";
import { Icon } from "@bb/shared-ui/icon";

const DESCRIPTION_SAVE_DELAY_MS = 800;

function SubTasksSection({
  ref,
  task,
  subtasks,
  onCreate,
}: {
  ref: React.Ref<HTMLElement>;
  task: Task;
  subtasks: Task[];
  onCreate: (title: string) => Promise<unknown>;
}) {
  const navigation = useTasksNavigation();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    onCreate(title.trim())
      .then(() => setTitle(""), reportError)
      .finally(() => setBusy(false));
  };

  return (
    <section ref={ref} className="mt-5">
      {subtasks.map((subtask) => (
        <button
          key={subtask.id}
          type="button"
          className="flex h-8 w-full items-center gap-2 border-b border-border-hairline px-0.5 text-left text-sm hover:bg-state-hover"
          title={STATUS_LABELS[subtask.status]}
          onClick={() => navigation.go({ kind: "task", taskKey: subtask.key })}
        >
          <StatusIcon status={subtask.status} />
          <span className="shrink-0 text-xs text-muted-foreground">
            {subtask.key}
          </span>
          <span className="min-w-0 truncate">{subtask.title}</span>
        </button>
      ))}
      {adding ? (
        <div className="flex h-8 items-center gap-2 border-b border-border-hairline px-0.5">
          <StatusIcon status="todo" className="opacity-60" />
          <input
            autoFocus
            value={title}
            placeholder={`Sub-task of ${task.key}…`}
            className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
              if (event.key !== "Escape") return;
              setAdding(false);
              setTitle("");
            }}
            onBlur={() => {
              if (!title.trim()) setAdding(false);
            }}
          />
        </div>
      ) : null}
      <button
        type="button"
        className="flex items-center gap-1.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setAdding(true)}
      >
        <Icon name="Plus" className="size-3" />
        Add sub-task
      </button>
    </section>
  );
}

function TaskDetailPage({
  detail,
  presets,
}: {
  detail: TaskDetail;
  presets: Preset[] | undefined;
}) {
  const { task, project, parent, subtasks, labels, threads } = detail;
  const navigation = useTasksNavigation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const subtasksRef = useRef<HTMLElement>(null);

  const update = useCallback(
    (input: Omit<UpdateTaskInput, "taskId">) =>
      callOp(tasks.updateTask, { taskId: task.id, ...input }).catch(
        reportError,
      ),
    [task.id],
  );

  const [draft, setDraft] = useState<string | null>(null);
  const unsaved = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveDescription = useCallback(() => {
    clearTimeout(timer.current);
    const description = unsaved.current;
    unsaved.current = null;
    if (description !== null) void update({ description });
  }, [update]);
  useEffect(() => saveDescription, [saveDescription]);
  useEffect(() => {
    if (unsaved.current === null && draft === task.description) setDraft(null);
  }, [draft, task.description]);
  const onDescriptionChange = (markdown: string) => {
    setDraft(markdown);
    unsaved.current = markdown;
    clearTimeout(timer.current);
    timer.current = setTimeout(saveDescription, DESCRIPTION_SAVE_DELAY_MS);
  };

  const upload = (file: File) => uploadAttachment(file, task.id);
  const done = subtasks.filter((subtask) => subtask.status === "done").length;
  const properties = { task, project, labels, threads, presets };

  return (
    <div className="@container flex min-h-full flex-col bg-surface-recessed-solid p-3">
      <div className="flex flex-1 items-stretch rounded-lg border border-border bg-card shadow-2xs">
        <div className="mx-auto w-full min-w-0 max-w-[55rem] flex-1 px-7 pb-16 pt-8 @3xl:px-13 @3xl:pt-11">
          {parent || subtasks.length > 0 ? (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              {parent ? (
                <button
                  type="button"
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground shadow-2xs hover:border-input"
                  onClick={() =>
                    navigation.go({ kind: "task", taskKey: parent.key })
                  }
                >
                  Sub-task of
                  <StatusIcon status={parent.status} className="size-3" />
                  <span className="font-medium text-foreground">
                    {parent.key}
                  </span>
                  <span className="min-w-0 truncate">{parent.title}</span>
                </button>
              ) : null}
              {subtasks.length > 0 ? (
                <button
                  type="button"
                  title="Sub-tasks completed"
                  onClick={() =>
                    subtasksRef.current?.scrollIntoView({
                      behavior: "smooth",
                      block: "center",
                    })
                  }
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground shadow-2xs hover:border-input hover:text-foreground"
                >
                  <span
                    aria-hidden
                    className="inline-block size-3 rounded-full"
                    style={{
                      background: `conic-gradient(var(--primary) ${(done / subtasks.length) * 360}deg, var(--muted) 0)`,
                    }}
                  />
                  {done}/{subtasks.length} sub-tasks
                </button>
              ) : null}
            </div>
          ) : null}

          <h1
            key={`${task.id}:${task.title}`}
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-label="Task title"
            className="mb-2.5 mt-1 text-2xl font-semibold leading-tight outline-none"
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              event.currentTarget.blur();
            }}
            onBlur={(event) => {
              const title = event.currentTarget.textContent?.trim() ?? "";
              if (!title) event.currentTarget.textContent = task.title;
              else if (title !== task.title) void update({ title });
            }}
          >
            {task.title}
          </h1>

          <TaskProperties
            variant="inline"
            {...properties}
            onUpdate={(change) => void update(change)}
            className="mb-4 @[45rem]:hidden"
          />

          <MarkdownField
            value={draft ?? task.description}
            onChange={onDescriptionChange}
            onBlur={saveDescription}
            className="min-h-24"
            placeholder="Add a description… markdown: headings, lists, code, tables"
            onUploadFile={upload}
          />

          <div className="mb-1 mt-3 flex items-center gap-1">
            <button
              type="button"
              title="Attach file"
              aria-label="Attach file"
              className="flex size-6.5 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground"
              onClick={() => fileInputRef.current?.click()}
            >
              <Icon name="Paperclip" className="size-4" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                for (const file of event.target.files ?? []) {
                  upload(file).catch(reportError);
                }
                event.target.value = "";
              }}
            />
          </div>

          <AttachmentsGrid
            attachments={detail.attachments}
            onRemove={({ id: attachmentId }) =>
              callOp(tasks.deleteAttachment, { attachmentId })
            }
          />

          <SubTasksSection
            ref={subtasksRef}
            task={task}
            subtasks={subtasks}
            onCreate={(title) =>
              callOp(tasks.createTask, {
                projectId: task.projectId,
                title,
                parentTaskId: task.id,
                status: "todo",
              })
            }
          />

          {threads.length > 0 ? (
            <div className="mt-6">
              <ThreadsSection taskId={task.id} threads={threads} />
            </div>
          ) : null}

          <div className="mt-1">
            <TaskActivity
              taskId={task.id}
              comments={detail.comments}
              attachments={detail.commentAttachments}
            />
          </div>
        </div>

        <TaskProperties
          variant="rail"
          {...properties}
          onUpdate={(change) => void update(change)}
          className="hidden @[45rem]:block"
        />
      </div>
    </div>
  );
}

export function DetailView({
  taskKey,
  onCanonicalKey,
}: {
  taskKey: string;
  onCanonicalKey?: (taskKey: string) => void;
}) {
  const query = useTasksQuery(
    async () => (await callOp(tasks.taskDetail, { taskKey })).detail,
    [taskKey],
  );
  const presets = usePresets();
  const canonicalKey = query.data?.task.key;
  useEffect(() => {
    if (canonicalKey) onCanonicalKey?.(canonicalKey);
  }, [canonicalKey, onCanonicalKey]);

  if (query.data) {
    return <TaskDetailPage detail={query.data} presets={presets.data} />;
  }
  if (query.data === undefined) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">
        {query.error}
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
      <Icon name="FileQuestion" className="size-5" />
      Task {taskKey} was not found.
    </div>
  );
}
