import { nanoid } from "nanoid";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  machineEnvironmentSetSchema,
  type MachineEnvironmentVariable,
} from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { OptionPicker } from "@bb/app-kit/components/pickers/OptionPicker";
import { getSettingsSectionRoutePath } from "@bb/app-kit/components/settings/settings-sections";
import { SettingsSection } from "@bb/app-kit/components/ui/settings-section";
import {
  invalidateMachineEnvironment,
  invalidateSystemConfig,
} from "@bb/app-kit/hooks/mutations/settings-mutations";
import { machineEnvironmentQueryKey } from "@bb/app-kit/hooks/queries/query-keys";
import { useSidebarNavigation } from "@bb/app-kit/hooks/queries/sidebar-navigation-query";
import { sdk } from "@bb/app-kit/lib/sdk";

const GLOBAL_SCOPE = "global";
const ROW_GRID_CLASS_NAME =
  "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]";
const ROW_CAPTION_CLASS_NAME = "text-xs leading-snug text-subtle-foreground";

type DraftRow = Omit<MachineEnvironmentVariable, "value"> & {
  id: string;
  nameLocked: boolean;
  value: string | null;
};

export function MachineEnvironmentSettings() {
  const [scope, setScope] = useState(GLOBAL_SCOPE);
  const projects = useSidebarNavigation().data?.projects ?? [];
  const selected = projects.find((project) => project.id === scope) ?? null;
  return (
    <ScopedMachineEnvironmentSettings
      key={selected?.id ?? GLOBAL_SCOPE}
      projectId={selected?.id ?? null}
      scopeControl={
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <span className="text-sm text-subtle-foreground">
            Showing variables for
          </span>
          <OptionPicker
            modal={false}
            label="Scope"
            className="text-sm"
            value={selected?.id ?? GLOBAL_SCOPE}
            onChange={setScope}
            options={[
              { value: GLOBAL_SCOPE, label: "All projects" },
              ...projects.map((project) => ({
                value: project.id,
                label: project.name,
              })),
            ]}
          />
        </div>
      }
    />
  );
}

function GlobalSettingsLink() {
  return (
    <Link
      to={getSettingsSectionRoutePath("environment-variables")}
      className="rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      global settings
    </Link>
  );
}

function RowScope({ children }: { children: string }) {
  return (
    <>
      <span className="text-foreground">{children}</span>
      {" · "}
    </>
  );
}

export function ScopedMachineEnvironmentSettings({
  projectId,
  scopeControl,
}: {
  projectId: string | null;
  scopeControl?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: machineEnvironmentQueryKey(projectId),
    queryFn: async () =>
      projectId === null
        ? { ...(await sdk.system.machineEnvironment()), inheritedVariables: [] }
        : sdk.projects.machineEnvironment({ projectId }),
  });
  const environment = query.data ?? null;
  const [draft, setDraft] = useState<DraftRow[] | null>(null);
  const [visible, setVisible] = useState<readonly string[]>([]);
  const [touched, setTouched] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const saved = environment?.variables ?? [];
  const rows =
    draft ?? saved.map((row) => ({ ...row, id: row.name, nameLocked: true }));
  const issueOf = (row: DraftRow) =>
    rows.filter((other) => other.name === row.name).length > 1
      ? "Variable name already exists."
      : machineEnvironmentSetSchema.safeParse({
            name: row.name,
            value: row.value ?? "",
            note: row.note,
          }).success
        ? null
        : !row.name
          ? "Enter a variable name."
          : "Use uppercase letters, numbers, and underscores; start with a letter or underscore.";
  const reset = () => {
    setDraft(null);
    setVisible([]);
    setError(null);
  };
  const mutation = useMutation({
    mutationFn: async () => {
      const input = {
        variables: rows.map(({ name, value, note }) => ({ name, value, note })),
      };
      if (projectId === null) await sdk.system.replaceMachineEnvironment(input);
      else
        await sdk.projects.replaceMachineEnvironment({ ...input, projectId });
    },
    onSuccess: () => {
      invalidateMachineEnvironment({ queryClient });
      invalidateSystemConfig({ queryClient });
      reset();
    },
    onError: () => {
      void query.refetch();
      setError(
        "Some changes could not be saved. Your edits are retained; try saving again.",
      );
    },
  });
  const disabled = environment === null || mutation.isPending;
  const isDirty =
    draft !== null &&
    (draft.length !== saved.length ||
      draft.some((row, index) => {
        const base = saved[index];
        return (
          base?.name !== row.name ||
          base.note !== row.note ||
          row.value !== null
        );
      }));
  const edit = (next: DraftRow[]) => {
    setDraft(next);
    setError(null);
  };
  const newRow = (): DraftRow => ({
    id: nanoid(),
    nameLocked: false,
    name: "",
    value: "",
    secret: true,
    note: null,
  });
  const inherited = environment?.inheritedVariables ?? [];
  const inheritedNames = inherited.map((variable) => variable.name);
  const renderRow = (row: DraftRow, overridesGlobal: boolean) => {
    const index = rows.indexOf(row);
    const issue = touched.includes(row.id) ? issueOf(row) : null;
    const revealed = visible.includes(row.id);
    const change = (patch: Partial<DraftRow>) =>
      edit(rows.map((other) => (other === row ? { ...row, ...patch } : other)));
    const caption = overridesGlobal ? (
      <>
        <RowScope>Override</RowScope>
        {row.note ?? "Replaces the global value; remove it to inherit again."}
      </>
    ) : (
      row.note
    );
    return (
      <div key={row.id} className="space-y-2">
        <div className={ROW_GRID_CLASS_NAME}>
          <Input
            className="col-span-2 font-mono sm:col-span-1"
            aria-label={`Variable name ${index + 1}`}
            placeholder="KEY"
            value={row.name}
            disabled={disabled}
            readOnly={row.nameLocked}
            aria-invalid={issue !== null}
            onBlur={() => setTouched([...touched, row.id])}
            onChange={(event) => change({ name: event.target.value })}
          />
          <div className="relative min-w-0">
            <Input
              className="min-w-0 pr-9 font-mono"
              aria-label={`Value for ${row.name || `variable ${index + 1}`}`}
              type={revealed ? "text" : "password"}
              placeholder={
                row.value === null ? "Saved secret · enter to replace" : "VALUE"
              }
              value={row.value ?? ""}
              autoComplete="off"
              disabled={disabled}
              onChange={(event) => change({ value: event.target.value })}
            />
            <Button
              size="icon"
              variant="ghost"
              className="absolute inset-y-0 right-0 my-auto size-8 text-subtle-foreground"
              aria-label={`${revealed ? "Hide" : "Show"} ${row.name || "value"}`}
              disabled={disabled || row.value === null}
              onClick={() =>
                setVisible(
                  revealed
                    ? visible.filter((id) => id !== row.id)
                    : [...visible, row.id],
                )
              }
            >
              <Icon name={revealed ? "EyeOff" : "Eye"} className="size-4" />
            </Button>
          </div>
          <Button
            size="icon"
            className="size-8 text-subtle-foreground"
            variant="ghost"
            aria-label={`Remove ${row.name || "variable"}`}
            disabled={disabled}
            onClick={() => setDraft(rows.filter((other) => other !== row))}
          >
            <Icon name="X" className="size-4" />
          </Button>
        </div>
        {caption && <p className={ROW_CAPTION_CLASS_NAME}>{caption}</p>}
        {issue && (
          <p role="alert" className="text-xs text-destructive-text">
            {issue}
          </p>
        )}
      </div>
    );
  };
  return (
    <SettingsSection
      title="Environment variables"
      description="Global variables are available to BB-managed processes on every connected machine. Project variables override them for work in that project."
      bodyClassName="space-y-8"
    >
      <div className="space-y-5 empty:hidden">
        {scopeControl}
        {environment === null && !query.isError && (
          <p className="text-xs text-subtle-foreground">Loading…</p>
        )}
        {inherited.map((variable) => {
          const row = rows.find((other) => other.name === variable.name);
          if (row) return renderRow(row, true);
          return (
            <div key={`inherited:${variable.name}`} className="space-y-2">
              <div className={ROW_GRID_CLASS_NAME}>
                <Input
                  className="col-span-2 font-mono sm:col-span-1"
                  aria-label={`Global variable ${variable.name}`}
                  value={variable.name}
                  readOnly
                />
                <Input
                  className="font-mono"
                  aria-label={`Global value for ${variable.name}`}
                  value="••••••••"
                  readOnly
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8 text-subtle-foreground"
                  aria-label={`Override ${variable.name}`}
                  disabled={disabled}
                  onClick={() =>
                    setDraft([
                      ...rows,
                      {
                        ...variable,
                        id: variable.name,
                        nameLocked: true,
                        value: "",
                      },
                    ])
                  }
                >
                  <Icon name="Edit" className="size-4" />
                </Button>
              </div>
              <p className={ROW_CAPTION_CLASS_NAME}>
                <RowScope>Global</RowScope>
                {variable.note ?? (
                  <>
                    Inherited from <GlobalSettingsLink />.
                  </>
                )}
              </p>
            </div>
          );
        })}
        {environment !== null &&
          rows
            .filter((row) => !inheritedNames.includes(row.name))
            .map((row) => renderRow(row, false))}
      </div>
      {query.isError && (
        <p role="alert" className="text-xs text-destructive-text">
          Could not load machine variables. Try refreshing this page.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive-text">
          {error}
        </p>
      )}
      {environment !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="flex-1 sm:flex-none"
            disabled={disabled}
            onClick={() => setDraft([...rows, newRow()])}
          >
            Add variable
          </Button>
          <div className="ml-auto flex w-full items-center justify-end gap-2 sm:w-auto">
            {isDirty && (
              <Button
                size="sm"
                variant="ghost"
                disabled={mutation.isPending}
                onClick={reset}
              >
                Discard changes
              </Button>
            )}
            <Button
              size="sm"
              disabled={disabled || !isDirty || rows.some(issueOf)}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? "Saving…" : "Save variables"}
            </Button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
