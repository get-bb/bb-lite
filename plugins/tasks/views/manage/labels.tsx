import { useState } from "react";
import type { Label, Project } from "../../shared/contract.js";
import { errorMessage, useLabels, useTasksRpc } from "../../shell/data.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bb/shared-ui/select";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Icon } from "@bb/shared-ui/icon";
import { ConfirmDialog } from "../../components/common.js";
import { ColorSwatchPicker, DEFAULT_COLOR } from "./shared.js";

function LabelEditorRow({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: Pick<Label, "name" | "color">;
  submitLabel: string;
  onSubmit: (name: string, color: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [color, setColor] = useState(initial.color);
  const submit = () => {
    void onSubmit(name.trim(), color).then(() => {
      if (onCancel) return;
      setName("");
      setColor(DEFAULT_COLOR);
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={name}
        placeholder="Label name"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && name.trim() !== "") {
            event.preventDefault();
            submit();
          }
        }}
        className="h-7 w-44 text-xs"
      />
      <ColorSwatchPicker value={color} onChange={setColor} />
      <Button
        size="sm"
        variant="outline"
        className="h-7"
        disabled={name.trim() === ""}
        onClick={submit}
      >
        {submitLabel}
      </Button>
      {onCancel ? (
        <Button size="sm" variant="ghost" className="h-7" onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
    </div>
  );
}

function projectLabel(project: Project) {
  return (
    <span key={project.id} className="flex items-center gap-2">
      <span
        aria-hidden
        className="size-2.5 rounded-sm"
        style={{ backgroundColor: project.color }}
      />
      {project.name}
    </span>
  );
}

export function LabelsPanel({ projects }: { projects: Project[] }) {
  const rpc = useTasksRpc();
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const projectId = selectedProjectId ?? projects[0]?.id;
  const labels = useLabels(projectId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Label | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    await action().catch((cause: unknown) => setError(errorMessage(cause)));
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4">
      <header className="space-y-1">
        <h2 className="text-base font-semibold">Manage</h2>
        <p className="text-sm text-muted-foreground">Project labels.</p>
      </header>
      {projectId === undefined ? (
        <p className="text-sm text-muted-foreground">
          Create a project first — labels are project-scoped.
        </p>
      ) : (
        <div className="space-y-3">
          <Select
            value={projectId}
            onValueChange={(value) => {
              setSelectedProjectId(value);
              setEditingId(null);
            }}
          >
            <SelectTrigger aria-label="Project" className="h-8 w-56">
              <SelectValue placeholder="Project">
                {projects
                  .filter((project) => project.id === projectId)
                  .map(projectLabel)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {projectLabel(project)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="divide-y divide-border-hairline rounded-md border border-border">
            {(labels.data ?? []).map((label) => (
              <div key={label.id} className="px-3 py-2">
                {editingId === label.id ? (
                  <LabelEditorRow
                    initial={label}
                    submitLabel="Save"
                    onCancel={() => setEditingId(null)}
                    onSubmit={(name, color) =>
                      run(async () => {
                        const patch = { labelId: label.id, name, color };
                        await rpc.call("updateLabel", patch);
                        setEditingId(null);
                      })
                    }
                  />
                ) : (
                  <div className="group flex items-center gap-2">
                    <span
                      aria-hidden
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: label.color }}
                    />
                    <span className="flex-1 text-sm">{label.name}</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-6 text-muted-foreground opacity-0 group-hover:opacity-100"
                      aria-label={`Edit label ${label.name}`}
                      onClick={() => setEditingId(label.id)}
                    >
                      <Icon name="Edit" className="size-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-6 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                      aria-label={`Delete label ${label.name}`}
                      onClick={() => setDeleting(label)}
                    >
                      <Icon name="Trash2" className="size-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {labels.data?.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">
                No labels yet.
              </p>
            ) : null}
          </div>
          <LabelEditorRow
            initial={{ name: "", color: DEFAULT_COLOR }}
            submitLabel="Add label"
            onSubmit={(name, color) =>
              run(() => rpc.call("createLabel", { projectId, name, color }))
            }
          />
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <ConfirmDialog
            open={deleting !== null}
            onOpenChange={(open) => {
              if (!open) setDeleting(null);
            }}
            title={`Delete label “${deleting?.name ?? ""}”?`}
            description="Tasks that use this label lose it."
            confirmLabel="Delete label"
            onConfirm={() => {
              const labelId = deleting?.id;
              if (labelId) void run(() => rpc.call("deleteLabel", { labelId }));
            }}
          />
        </div>
      )}
    </div>
  );
}
