import { callOp } from "@bb/plugin/app";
import { useState } from "react";
import { errorMessage, useOverview, useTasksQuery } from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { tasks, PROJECT_PREFIX_PATTERN } from "../../shared/contract.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import {
  BbProjectLinkPicker,
  ColorSwatchPicker,
  DEFAULT_COLOR,
  derivePrefix,
  Field,
} from "./shared.js";

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const navigation = useTasksNavigation();
  const projects = useOverview().data?.projects ?? [];
  const bbProjects = useTasksQuery(
    async () => (await callOp(tasks.listBbProjects, {})).bbProjects,
  );
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [prefixTouched, setPrefixTouched] = useState(false);
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [linkedBbProjectId, setLinkedBbProjectId] = useState<string | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clash = projects.find((project) => project.prefix === prefix);
  const prefixError =
    prefix === ""
      ? null
      : !PROJECT_PREFIX_PATTERN.test(prefix)
        ? "Use 1–10 uppercase letters and digits, starting with a letter."
        : clash
          ? `Already used by ${clash.name}.`
          : null;
  const canSubmit =
    name.trim().length > 0 &&
    prefix.length > 0 &&
    prefixError === null &&
    !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const input = { name: name.trim(), prefix, color, linkedBbProjectId };
      const { project } = await callOp(tasks.createProject, input);
      onClose();
      navigation.go({ kind: "project", projectId: project.id });
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => open || onClose()}>
      <DialogContent
        className="max-w-md"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Projects group tasks under a shared key prefix.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Name">
            <Input
              autoFocus
              value={name}
              placeholder="e.g. Tasks Plugin"
              onChange={(event) => {
                setName(event.target.value);
                if (!prefixTouched) setPrefix(derivePrefix(event.target.value));
              }}
              className="h-8"
            />
          </Field>
          <Field
            label="Prefix"
            hint={
              prefixError ??
              "Task keys use this prefix, e.g. TSK-12. Uppercase, unique."
            }
          >
            <Input
              value={prefix}
              placeholder="TSK"
              aria-invalid={prefixError !== null}
              onChange={(event) => {
                setPrefixTouched(true);
                setPrefix(event.target.value.toUpperCase());
              }}
              className={
                prefixError !== null
                  ? "h-8 w-32 border-destructive focus-visible:ring-destructive"
                  : "h-8 w-32"
              }
            />
          </Field>
          <Field label="Color">
            <ColorSwatchPicker value={color} onChange={setColor} />
          </Field>
          <Field
            label="Linked bb project"
            hint="Optional. Linking a bb project enables dispatching to agents."
          >
            <BbProjectLinkPicker
              value={linkedBbProjectId}
              onChange={setLinkedBbProjectId}
              bbProjects={bbProjects.data ?? []}
            />
          </Field>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
            Create project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
