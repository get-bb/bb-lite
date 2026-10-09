import {
  PluginCliError,
  cliCommand,
  defineCli,
  type CliContext,
  type PluginServerApi,
} from "@bb/plugin";
import {
  permissionModeSchema,
  permissionModeValues,
  reasoningLevelSchema,
  reasoningLevelValues,
  serviceTierSchema,
} from "@bb/domain";
import {
  RUNS_LIMIT_DEFAULT,
  RUNS_LIMIT_MAX,
  automations,
  type AgentExecution,
  type Automation,
  type Run,
  type Trigger,
} from "./contract.js";

const SCRIPT_UNAVAILABLE =
  "Script automations are not available yet in this version of bb.";

const PROJECT = {
  type: "string",
  placeholder: "id",
  description: "Project id",
} as const;
const JSON_OPTION = { type: "boolean", description: "Print JSON" } as const;
const ID = [
  {
    name: "automationId",
    description: "Automation id from `bb automation list`",
    required: true,
  },
] as const;

const SCHEDULE = {
  cron: {
    type: "string",
    placeholder: "expression",
    description: "Recurring five-field cron expression; needs --timezone",
  },
  timezone: {
    type: "string",
    placeholder: "iana-timezone",
    description: "IANA timezone for --cron, for example America/New_York",
  },
  at: {
    type: "string",
    placeholder: "datetime",
    description: "One-shot run time, preferably ISO 8601",
  },
  in: {
    type: "string",
    placeholder: "duration",
    description: "One-shot delay from now: 30s, 5m, 2h, or 1d",
  },
} as const;

const AGENT = {
  prompt: {
    type: "string",
    placeholder: "text",
    description: "Prompt the agent runs when the automation is due",
  },
  provider: {
    type: "string",
    placeholder: "id",
    description: "Provider id, for example claude or codex",
  },
  model: {
    type: "string",
    placeholder: "model",
    description: "Model id the provider accepts",
  },
  reasoning: {
    type: "enum",
    values: reasoningLevelValues,
    description: "Reasoning level; new automations default to medium",
  },
  "service-tier": {
    type: "enum",
    values: serviceTierSchema.options,
    description: "Provider service tier",
  },
  "clear-service-tier": {
    type: "boolean",
    description: "Leave the automation without a service tier",
  },
  "permission-mode": {
    type: "enum",
    values: permissionModeValues,
    description: "Permission mode; defaults to auto",
  },
  "target-thread": {
    type: "string",
    placeholder: "thread-id",
    description: "Re-prompt this existing thread instead of spawning one",
  },
  environment: {
    type: "string",
    placeholder: "id-or-path",
    description: "Reuse an environment id, or run in a directory path",
  },
  "new-environment": {
    type: "enum",
    values: ["worktree"],
    description: "Create a fresh environment of this kind for each run",
  },
  "base-branch": {
    type: "string",
    placeholder: "branch",
    description: "Base branch for --new-environment worktree",
  },
} as const;

const SCRIPT = {
  script: {
    type: "string",
    placeholder: "inline",
    description: "Inline script body",
  },
  "script-file": {
    type: "string",
    placeholder: "path",
    description: "Script file",
  },
  host: {
    type: "string",
    placeholder: "name-or-id",
    description: "Machine for --script-file",
  },
  interpreter: {
    type: "enum",
    values: ["bash", "sh", "node", "python3"],
    description: "Script interpreter",
  },
  timeout: {
    type: "string",
    placeholder: "duration",
    description: "Run timeout",
  },
  "env-json": {
    type: "string",
    placeholder: "json",
    description: "Script environment as a JSON object",
  },
  "working-directory": {
    type: "string",
    placeholder: "automation-storage|project|path",
    description: "Script working directory",
  },
} as const;

type Values = Partial<
  Record<
    keyof typeof SCHEDULE | keyof typeof AGENT | keyof typeof SCRIPT,
    string | boolean
  >
>;

const fail = (message: string, code = "invalid_value"): never => {
  throw new PluginCliError(message, { code });
};
const text = (value: string | boolean | undefined): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const time = (value: number | null) =>
  value === null ? "-" : new Date(value).toLocaleString();

function projectOf(value: string | undefined, ctx: CliContext): string {
  if (value) return value;
  throw new PluginCliError("missing required option --project", {
    code: "missing_required",
    ...(ctx.projectId ? { hint: `Pass --project ${ctx.projectId}` } : {}),
  });
}

const UNITS: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 };

function trigger(options: Values, now: number): Trigger | undefined {
  const [cron, timezone, at, delay] = [
    text(options.cron),
    text(options.timezone),
    text(options.at),
    text(options.in),
  ];
  if ([cron, at, delay].filter(Boolean).length > 1) {
    fail("Choose only one of --cron, --at and --in.", "unexpected_argument");
  }
  if (cron && !timezone)
    fail("--cron requires --timezone.", "missing_required");
  if (timezone && !cron) fail("--timezone is only used with --cron.");
  if (cron && timezone) return { triggerType: "schedule", cron, timezone };
  if (at) {
    const runAt = Date.parse(at);
    if (Number.isNaN(runAt))
      fail("--at must be a valid date/time, preferably ISO 8601.");
    if (runAt <= now) fail("--at must be in the future.");
    return { triggerType: "once", runAt };
  }
  if (delay) {
    const match = /^(\d+)([smhd])$/u.exec(delay);
    if (!match) return fail("--in must be a duration like 30s, 5m, 2h, or 1d.");
    const amount = Number(match[1]) * (UNITS[match[2] ?? "s"] ?? 0);
    if (amount <= 0) fail("--in must be greater than zero.");
    return { triggerType: "once", runAt: now + amount };
  }
  return undefined;
}

function environment(
  options: Values,
): AgentExecution["environment"] | undefined {
  const reuse = text(options.environment);
  const fresh = text(options["new-environment"]);
  const base = text(options["base-branch"]);
  const target = text(options["target-thread"]);
  if ([reuse, fresh, target].filter(Boolean).length > 1) {
    fail(
      "Cannot combine target options: --target-thread, --environment, and --new-environment.",
      "unexpected_argument",
    );
  }
  if (base && !fresh)
    fail("--base-branch requires --new-environment worktree.");
  if (fresh) {
    const baseBranch = base
      ? { kind: "named" as const, name: base }
      : { kind: "default" as const };
    return {
      type: "host",
      workspace: { type: "managed-worktree", baseBranch },
    };
  }
  if (!reuse) return undefined;
  if (reuse.includes("/") || reuse.startsWith(".") || reuse.startsWith("~")) {
    return { type: "host", workspace: { type: "unmanaged", path: reuse } };
  }
  return { type: "reuse", environmentId: reuse };
}

function rejectScript(options: Values): void {
  if (
    Object.keys(SCRIPT).some(
      (name) => options[name as keyof Values] !== undefined,
    )
  ) {
    fail(SCRIPT_UNAVAILABLE, "unsupported");
  }
}

function agentPatch(options: Values): Partial<AgentExecution> {
  const serviceTier = text(options["service-tier"]);
  if (serviceTier && options["clear-service-tier"]) {
    fail(
      "Cannot combine --service-tier with --clear-service-tier.",
      "unexpected_argument",
    );
  }
  const env = environment(options);
  const patch: Partial<AgentExecution> = {};
  const prompt = text(options.prompt);
  const providerId = text(options.provider);
  const model = text(options.model);
  const reasoning = text(options.reasoning);
  const permission = text(options["permission-mode"]);
  const target = text(options["target-thread"]);
  if (prompt) patch.prompt = prompt;
  if (providerId) patch.providerId = providerId;
  if (model) patch.model = model;
  if (reasoning) patch.reasoningLevel = reasoningLevelSchema.parse(reasoning);
  if (permission) patch.permissionMode = permissionModeSchema.parse(permission);
  if (serviceTier) patch.serviceTier = serviceTierSchema.parse(serviceTier);
  if (target) patch.targetThreadId = target;
  if (env) patch.environment = env;
  return patch;
}

function newExecution(options: Values): AgentExecution {
  rejectScript(options);
  const patch = agentPatch(options);
  if (!patch.prompt)
    fail("Missing required option --prompt <value>.", "missing_required");
  if (!patch.providerId || !patch.model) {
    fail(
      "Agent automations require --provider and --model alongside --prompt.",
      "missing_required",
    );
  }
  return {
    prompt: "",
    providerId: "",
    model: "",
    reasoningLevel: "medium",
    permissionMode: "auto",
    environment: { type: "project-default" },
    ...patch,
    mode: "agent",
  };
}

function changedExecution(
  current: Automation,
  options: Values,
): AgentExecution | undefined {
  rejectScript(options);
  const patch = agentPatch(options);
  const clear = options["clear-service-tier"] === true;
  if (Object.keys(patch).length === 0 && !clear) return undefined;
  const next: AgentExecution = { ...current.execution, ...patch };
  if (patch.targetThreadId) next.environment = { type: "project-default" };
  if (patch.environment) delete next.targetThreadId;
  if (clear) delete next.serviceTier;
  return next;
}

function table(header: string[], rows: string[][]): string {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (row: string[]) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return `${[header, ...rows].map(line).join("\n")}\n`;
}

function schedule(trigger: Trigger): string {
  return trigger.triggerType === "schedule"
    ? `${trigger.cron} (${trigger.timezone})`
    : `once at ${time(trigger.runAt)}`;
}

function describe(automation: Automation): string {
  const { execution } = automation;
  const lines = [
    ["ID", automation.id],
    ["Name", automation.name],
    ["Enabled", automation.enabled ? "yes" : "no"],
    ["Schedule", schedule(automation.trigger)],
    ["Next run", time(automation.nextRunAt)],
    ["Last run", time(automation.lastRunAt)],
    ["Last status", automation.lastRunStatus ?? "-"],
    ["Runs", String(automation.runCount)],
    ["Mode", "agent"],
    ["Provider", `${execution.providerId} / ${execution.model}`],
    ["Target", execution.targetThreadId ?? execution.environment.type],
    ["Prompt", execution.prompt],
    ...(automation.lastError ? [["Last error", automation.lastError]] : []),
  ];
  return lines.map(([label, value]) => `${label}: ${value}`).join("\n") + "\n";
}

function runRows(runs: Run[]): string[][] {
  return runs.map((run) => [
    run.id,
    run.status,
    time(run.startedAt),
    run.threadId ?? (run.exitCode === null ? "-" : `exit ${run.exitCode}`),
    run.skipReason ?? run.error ?? "-",
  ]);
}

export function registerCli(bb: PluginServerApi): void {
  const call = bb.call.bind(bb);
  const one = (
    summary: string,
    op: typeof automations.pause | typeof automations.resume,
    verb: string,
  ) =>
    cliCommand({
      summary,
      positionals: ID,
      options: { project: PROJECT, json: JSON_OPTION },
      run: async ({ options, positionals }, ctx) => {
        const updated = await call(op, {
          projectId: projectOf(options.project, ctx),
          automationId: positionals.automationId,
        });
        return {
          exitCode: 0,
          stdout: options.json
            ? json(updated)
            : `Automation ${updated.id} ${verb}\n`,
        };
      },
    });

  bb.cli.register(
    defineCli({
      name: "automation",
      summary: "Inspect and manage automations (scheduled agent/script runs)",
      root: cliCommand({
        summary: "Show the automation commands",
        run: (input) => ({ exitCode: 0, stdout: input.help }),
      }),
      commands: {
        list: cliCommand({
          summary: "List automations for a project",
          options: { project: PROJECT, json: JSON_OPTION },
          run: async ({ options }, ctx) => {
            const list = await call(automations.list, {
              projectId: projectOf(options.project, ctx),
            });
            if (options.json) return { exitCode: 0, stdout: json(list) };
            if (list.length === 0)
              return { exitCode: 0, stdout: "No automations found\n" };
            const header = [
              "ID",
              "Name",
              "Status",
              "On",
              "Schedule",
              "Next run",
              "Runs",
              "Origin",
            ];
            const rows = list.map((a) => [
              a.id,
              a.name,
              "-",
              a.enabled ? "yes" : "no",
              schedule(a.trigger),
              time(a.nextRunAt),
              String(a.runCount),
              a.origin,
            ]);
            return { exitCode: 0, stdout: table(header, rows) };
          },
        }),
        create: cliCommand({
          summary: "Create an automation",
          description:
            "Pick exactly one schedule flag and the agent mode (--prompt --provider --model).",
          options: {
            project: PROJECT,
            name: {
              type: "string",
              placeholder: "name",
              required: true,
              description: "Display name, at most 200 characters",
            },
            disabled: {
              type: "boolean",
              description: "Create the automation paused",
            },
            ...SCHEDULE,
            ...AGENT,
            ...SCRIPT,
            json: JSON_OPTION,
          },
          run: async ({ options }, ctx) => {
            const when =
              trigger(options, bb.now()) ??
              fail("Choose one of --cron, --at or --in.", "missing_required");
            const created = await call(automations.create, {
              projectId: projectOf(options.project, ctx),
              name: options.name,
              enabled: !options.disabled,
              trigger: when,
              execution: newExecution(options),
              origin: ctx.threadId ? "agent" : "human",
              ...(ctx.threadId ? { createdByThreadId: ctx.threadId } : {}),
            });
            return {
              exitCode: 0,
              stdout: options.json
                ? json(created)
                : `Automation created: ${created.id}\n${describe(created)}`,
            };
          },
        }),
        show: cliCommand({
          summary: "Show automation details",
          positionals: ID,
          options: { project: PROJECT, json: JSON_OPTION },
          run: async ({ options, positionals }, ctx) => {
            const found = await call(automations.get, {
              projectId: projectOf(options.project, ctx),
              automationId: positionals.automationId,
            });
            return {
              exitCode: 0,
              stdout: options.json ? json(found) : describe(found),
            };
          },
        }),
        update: cliCommand({
          summary: "Update automation configuration",
          positionals: ID,
          options: {
            project: PROJECT,
            name: {
              type: "string",
              placeholder: "name",
              description: "Replacement display name, at most 200 characters",
            },
            ...SCHEDULE,
            ...AGENT,
            ...SCRIPT,
            json: JSON_OPTION,
          },
          run: async ({ options, positionals }, ctx) => {
            const ref = {
              projectId: projectOf(options.project, ctx),
              automationId: positionals.automationId,
            };
            const current = await call(automations.get, ref);
            const when = trigger(options, bb.now());
            const execution = changedExecution(current, options);
            const updated = await call(automations.update, {
              ...ref,
              ...(options.name !== undefined ? { name: options.name } : {}),
              ...(when ? { trigger: when } : {}),
              ...(execution ? { execution } : {}),
            });
            return {
              exitCode: 0,
              stdout: options.json
                ? json(updated)
                : `Automation ${updated.id} updated\n${describe(updated)}`,
            };
          },
        }),
        pause: one("Pause an automation", automations.pause, "paused"),
        resume: one("Resume an automation", automations.resume, "resumed"),
        run: cliCommand({
          summary: "Run an automation now",
          positionals: ID,
          options: {
            project: PROJECT,
            "idempotency-key": {
              type: "string",
              placeholder: "key",
              description:
                "Reuse the run started by an earlier call with this key, at most 200 characters",
            },
            json: JSON_OPTION,
          },
          run: async ({ options, positionals }, ctx) => {
            const key = options["idempotency-key"];
            const result = await call(automations.run, {
              projectId: projectOf(options.project, ctx),
              automationId: positionals.automationId,
              ...(key ? { idempotencyKey: key } : {}),
            });
            const thread = result.run.threadId
              ? `Thread: ${result.run.threadId}\n`
              : "";
            return {
              exitCode: 0,
              stdout: options.json
                ? json(result)
                : `Run started: ${result.run.id}\n${thread}`,
            };
          },
        }),
        runs: cliCommand({
          summary: "List automation runs",
          positionals: ID,
          options: {
            project: PROJECT,
            limit: {
              type: "integer",
              default: RUNS_LIMIT_DEFAULT,
              description: `How many recent runs to read (at most ${RUNS_LIMIT_MAX})`,
            },
            output: {
              type: "string",
              placeholder: "runId",
              description:
                "Print only this run's captured output; it must be inside --limit",
            },
            json: JSON_OPTION,
          },
          run: async ({ options, positionals }, ctx) => {
            const result = await call(automations.runs, {
              projectId: projectOf(options.project, ctx),
              automationId: positionals.automationId,
              limit: options.limit,
            });
            if (options.output) {
              const run =
                result.runs.find(
                  (candidate) => candidate.id === options.output,
                ) ??
                fail(
                  `Run ${options.output} not found in returned runs. Increase --limit if it is older.`,
                  "not_found",
                );
              return {
                exitCode: 0,
                stdout: options.json ? json(run) : `${run.output ?? ""}\n`,
              };
            }
            if (options.json) return { exitCode: 0, stdout: json(result) };
            if (result.runs.length === 0)
              return { exitCode: 0, stdout: "No runs found\n" };
            const header = ["ID", "Status", "Started", "Thread/Exit", "Detail"];
            return { exitCode: 0, stdout: table(header, runRows(result.runs)) };
          },
        }),
        delete: cliCommand({
          summary: "Delete an automation",
          positionals: ID,
          options: {
            project: PROJECT,
            yes: {
              type: "boolean",
              description: "Required. Confirms the automation is deleted",
            },
            json: JSON_OPTION,
          },
          run: async ({ options, positionals }, ctx) => {
            if (!options.yes) {
              fail(
                "Deletion requires --yes when run through the plugin CLI.",
                "missing_required",
              );
            }
            const automationId = positionals.automationId;
            await call(automations.delete, {
              projectId: projectOf(options.project, ctx),
              automationId,
            });
            return {
              exitCode: 0,
              stdout: options.json
                ? json({ ok: true, id: automationId })
                : `Automation ${automationId} deleted\n`,
            };
          },
        }),
      },
    }),
  );
}
