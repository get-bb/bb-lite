import { callOp } from "@bb/plugin/app";
import { useState } from "react";
import {
  tasks,
  type Project,
  type TaskPriority,
  type TaskStatus,
} from "../../shared/contract.js";
import { errorMessage, useLabels } from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { MarkdownEditor } from "../../editor/markdown.js";
import { LabelPicker } from "../detail/rail.js";
import {
  PriorityEditor,
  PropertyEditor,
  StatusEditor,
} from "../list/property-menus.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";

const CHIP_TRIGGER =
  "inline-flex h-7 max-w-44 items-center gap-1.5 rounded-md border border-input px-2 text-xs text-muted-foreground hover:text-foreground";
const BLANK = {
  title: "",
  description: "",
  status: "todo" as TaskStatus,
  priority: "none" as TaskPriority,
  labelIds: [] as string[],
};

function Swatch({ color }: { color: string | undefined }) {
  return (
    <span
      aria-hidden
      className="size-3 shrink-0 rounded-sm"
      style={{ backgroundColor: color }}
    />
  );
}

export function NewTaskDialog({
  onClose,
  projects,
  projectId,
}: {
  onClose: () => void;
  projects: Project[];
  projectId: string | null;
}) {
  const navigation = useTasksNavigation();
  const [chosenProjectId, setChosenProjectId] = useState(projectId);
  const [draft, setDraft] = useState(BLANK);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (change: Partial<typeof BLANK>) =>
    setDraft((current) => ({ ...current, ...change }));

  const project =
    projects.find((entry) => entry.id === chosenProjectId) ?? projects[0];
  const labels = useLabels(project?.id);
  const selectedLabels = (labels.data ?? []).filter((label) =>
    draft.labelIds.includes(label.id),
  );
  const canSubmit = project && draft.title.trim() !== "" && !submitting;

  const submit = () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const input = { ...draft, title: draft.title.trim() };
    callOp(tasks.createTask, { projectId: project.id, ...input })
      .then(({ task }) => {
        onClose();
        navigation.go({ kind: "task", taskKey: task.key });
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setSubmitting(false));
  };

  return (
    <Dialog open onOpenChange={(open) => open || onClose()}>
      <DialogContent
        className="flex max-h-[85dvh] min-h-0 max-w-xl flex-col gap-0 p-0"
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey))
            return;
          event.preventDefault();
          submit();
        }}
      >
        <DialogTitle className="flex shrink-0 items-center gap-2 px-4 pt-4 text-xs font-normal text-muted-foreground">
          {project ? <Swatch color={project.color} /> : null}
          New task
          {project ? ` · ${project.name}` : ""}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Create a task with a title, description and attributes.
        </DialogDescription>
        <div className="flex min-h-0 flex-auto flex-col px-4 pt-2">
          <input
            autoFocus
            value={draft.title}
            onChange={(event) => set({ title: event.target.value })}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing)
                return;
              event.preventDefault();
              event.stopPropagation();
              submit();
            }}
            placeholder="Task title"
            aria-label="Task title"
            className="w-full shrink-0 bg-transparent text-base font-semibold text-foreground outline-none placeholder:text-muted-foreground"
          />
          <MarkdownEditor
            variant="comment"
            value={draft.description}
            onChange={(description) => set({ description })}
            placeholder="Description — markdown, as agents read it"
            className="mt-2 min-h-16 flex-auto overflow-y-auto"
          />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-4 pt-3">
          {project ? (
            <PropertyEditor
              labelled
              value={project.id}
              className={CHIP_TRIGGER}
              onSelect={(id) => {
                setChosenProjectId(id);
                set({ labelIds: [] });
              }}
              kind={{
                values: projects.map((entry) => entry.id),
                labels: Object.fromEntries(
                  projects.map((entry) => [entry.id, entry.name]),
                ),
                icon: (id) => (
                  <Swatch
                    color={projects.find((entry) => entry.id === id)?.color}
                  />
                ),
                heading: "Project…",
                letter: "",
                firstShortcut: 1,
                width: "min-w-52",
              }}
            />
          ) : null}
          <StatusEditor
            labelled
            value={draft.status}
            onSelect={(status) => set({ status })}
            className={CHIP_TRIGGER}
          />
          <PriorityEditor
            labelled
            value={draft.priority}
            onSelect={(priority) => set({ priority })}
            className={CHIP_TRIGGER}
          />
          <LabelPicker
            projectId={project?.id}
            labels={labels.data}
            selectedIds={draft.labelIds}
            onChange={(labelIds) => set({ labelIds })}
          >
            <button type="button" className={CHIP_TRIGGER}>
              {selectedLabels.length === 0 ? (
                <Icon name="Plus" className="size-3" />
              ) : (
                <span className="flex items-center gap-0.5">
                  {selectedLabels.slice(0, 3).map((label) => (
                    <span
                      key={label.id}
                      aria-hidden
                      className="size-2 rounded-full"
                      style={{ backgroundColor: label.color }}
                    />
                  ))}
                </span>
              )}
              {selectedLabels.length === 0
                ? "Labels"
                : selectedLabels.length === 1
                  ? selectedLabels[0]?.name
                  : `${selectedLabels.length} labels`}
            </button>
          </LabelPicker>
        </div>
        {error ? (
          <p
            role="alert"
            className="shrink-0 px-4 pt-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
        <DialogFooter className="mt-4 shrink-0 flex-row items-center justify-end border-t border-border-hairline px-4 py-3">
          <Button size="sm" disabled={!canSubmit} onClick={submit}>
            Create task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
