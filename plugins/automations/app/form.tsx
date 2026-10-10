import { useState, type ReactNode } from "react";
import {
  projects,
  sessions,
  useCall,
  useOp,
  useProviders,
} from "@bb/plugin/app";
import {
  permissionModeValues,
  reasoningLevelValues,
  type PermissionMode,
  type ReasoningLevel,
} from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Label } from "@bb/shared-ui/label";
import { Textarea } from "@bb/shared-ui/textarea";
import { type Automation, automations, type Trigger } from "../contract.js";
import { describeCron } from "./schedule.js";

const SELECT = "h-9 rounded-md border bg-transparent px-2 text-sm";

function toLocalInput(timestamp: number): string {
  const date = new Date(timestamp - new Date().getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Choice<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: readonly { value: Value; label: string }[];
  onChange: (value: Value) => void;
}) {
  return (
    <Field label={label}>
      <select
        aria-label={label}
        className={SELECT}
        value={value}
        onChange={(event) => {
          const next = options.find((o) => o.value === event.target.value);
          if (next) onChange(next.value);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

const plain = <Value extends string>(values: readonly Value[]) =>
  values.map((value) => ({ value, label: value }));

export function AutomationForm({
  automation,
  projectId: initialProjectId,
  onDone,
  onCancel,
}: {
  automation?: Automation;
  projectId: string | null;
  onDone: (automation: Automation) => void;
  onCancel: () => void;
}) {
  const execution =
    automation?.execution.mode === "agent" ? automation.execution : undefined;
  const trigger = automation?.trigger;
  const projectList = useOp(
    projects.list,
    { includePersonal: true },
    { enabled: automation === undefined },
  );
  const { providers } = useProviders();
  const available = providers.filter((provider) => provider.available);
  const create = useCall(automations.create);
  const update = useCall(automations.update);
  const [projectId, setProjectId] = useState(initialProjectId ?? "");
  const [name, setName] = useState(automation?.name ?? "");
  const [kind, setKind] = useState<Trigger["triggerType"]>(
    trigger?.triggerType ?? "schedule",
  );
  const [cron, setCron] = useState(
    trigger?.triggerType === "schedule" ? trigger.cron : "0 9 * * 1-5",
  );
  const [timezone, setTimezone] = useState(
    trigger?.triggerType === "schedule"
      ? trigger.timezone
      : Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [runAt, setRunAt] = useState(
    toLocalInput(
      trigger?.triggerType === "once" ? trigger.runAt : Date.now() + 3600_000,
    ),
  );
  const [prompt, setPrompt] = useState(execution?.prompt ?? "");
  const [providerId, setProviderId] = useState(execution?.providerId ?? "");
  const [model, setModel] = useState(execution?.model ?? "");
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>(
    execution?.reasoningLevel ?? "medium",
  );
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    execution?.permissionMode ?? "auto",
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const projectOptions = (projectList.data ?? []).map((project) => ({
    value: project.id,
    label: project.name,
  }));
  const chosenProject = projectId || projectOptions[0]?.value || "";
  const chosenProvider = providerId || available[0]?.id || "";
  const executionOptions = useOp(
    sessions.executionOptions,
    { providerId: chosenProvider },
    { enabled: chosenProvider !== "" },
  );
  const modelOptions = [
    { value: "", label: "Default" },
    ...(executionOptions.data?.models ?? []).map((option) => ({
      value: option.model,
      label: option.displayName,
    })),
  ];
  const chosenModel = executionOptions.data?.models.find((option) =>
    model ? option.model === model : option.isDefault,
  );
  const supported = chosenModel?.supportedReasoningEfforts.map(
    (option) => option.reasoningEffort,
  );
  const reasoningLevels: readonly ReasoningLevel[] =
    supported && supported.length > 0 ? supported : reasoningLevelValues;
  if (!reasoningLevels.includes(reasoningLevel)) {
    setReasoningLevel(chosenModel?.defaultReasoningEffort ?? "medium");
  }
  if (!modelOptions.some((option) => option.value === model)) {
    modelOptions.push({ value: model, label: model });
  }

  const submit = async () => {
    setError(null);
    setPending(true);
    const nextTrigger: Trigger =
      kind === "schedule"
        ? { triggerType: "schedule", cron: cron.trim(), timezone }
        : { triggerType: "once", runAt: new Date(runAt).getTime() };
    const nextExecution = {
      mode: "agent" as const,
      prompt,
      providerId: chosenProvider,
      model: model.trim() || chosenModel?.model || "",
      reasoningLevel,
      permissionMode,
      environment: execution?.environment ?? { type: "project-default" },
      ...(execution?.serviceTier && { serviceTier: execution.serviceTier }),
      ...(execution?.targetThreadId && {
        targetThreadId: execution.targetThreadId,
      }),
    };
    try {
      onDone(
        automation
          ? await update({
              projectId: automation.projectId,
              automationId: automation.id,
              name,
              trigger: nextTrigger,
              execution: nextExecution,
            })
          : await create({
              projectId: chosenProject,
              name,
              trigger: nextTrigger,
              execution: nextExecution,
              origin: "human",
            }),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="grid max-w-xl gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {automation === undefined && (
        <Choice
          label="Project"
          value={chosenProject}
          options={projectOptions}
          onChange={setProjectId}
        />
      )}
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Choice
        label="Runs"
        value={kind}
        options={[
          { value: "schedule", label: "On a schedule" },
          { value: "once", label: "Once" },
        ]}
        onChange={setKind}
      />
      {kind === "schedule" ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Cron">
            <Input value={cron} onChange={(e) => setCron(e.target.value)} />
          </Field>
          <Field label="Timezone">
            <Input
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            />
          </Field>
          <p className="col-span-2 text-xs text-muted-foreground">
            {describeCron(cron)}
          </p>
        </div>
      ) : (
        <Field label="Run at">
          <Input
            type="datetime-local"
            value={runAt}
            onChange={(e) => setRunAt(e.target.value)}
          />
        </Field>
      )}
      <Field label="Prompt">
        <Textarea
          rows={5}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Choice
          label="Provider"
          value={chosenProvider}
          options={available.map((p) => ({
            value: p.id,
            label: p.displayName,
          }))}
          onChange={setProviderId}
        />
        <Choice
          label="Model"
          value={model}
          options={modelOptions}
          onChange={setModel}
        />
        <Choice
          label="Reasoning"
          value={reasoningLevel}
          options={plain(reasoningLevels)}
          onChange={setReasoningLevel}
        />
        <Choice
          label="Permissions"
          value={permissionMode}
          options={plain(permissionModeValues)}
          onChange={setPermissionMode}
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {automation ? "Save" : "Create"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
