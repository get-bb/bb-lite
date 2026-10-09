import {
  PluginCliError,
  cliCommand,
  defineCli,
  machines,
  projects,
  sessions,
  type CliContext,
  type PluginServerApi,
} from "@bb/plugin";
import {
  permissionModeSchema,
  permissionModeValues,
  reasoningLevelSchema,
  reasoningLevelValues,
  serviceTierSchema,
  type PermissionMode,
} from "@bb/domain";
import { machineFiles } from "@bb/runner";
import { extname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  RUNS_LIMIT_DEFAULT,
  RUNS_LIMIT_MAX,
  INTERPRETERS,
  SCRIPT_TIMEOUT_DEFAULT_MS,
  SCRIPT_TIMEOUT_MAX_MS,
  automations,
  type AgentExecution,
  type Execution,
  type ScriptExecution,
  type WorkingDirectory,
  type Automation,
  type Run,
  type Trigger,
} from "./contract.js";

const SCHEDULE_RULES = [
  { kind: "requires", option: "cron", needs: ["timezone"] },
  { kind: "requires", option: "timezone", needs: ["cron"] },
] as const;
const TARGET_RULES = [
  {
    kind: "at-most-one",
    options: ["target-thread", "environment", "new-environment"],
  },
  { kind: "requires", option: "base-branch", needs: ["new-environment"] },
  { kind: "at-most-one", options: ["service-tier", "clear-service-tier"] },
  { kind: "at-most-one", options: ["script", "script-file"] },
] as const;

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
    type: "duration",
    min: 1,
    units: ["s"],
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
    type: "duration",
    min: 1,
    max: SCRIPT_TIMEOUT_MAX_MS,
    units: ["ms"],
    description: `Run timeout; a bare number is milliseconds (default ${SCRIPT_TIMEOUT_DEFAULT_MS}, max ${SCRIPT_TIMEOUT_MAX_MS})`,
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
    string | number | boolean
  >
>;

const fail = (message: string, code = "invalid_value"): never => {
  throw new PluginCliError(message, { code });
};
const text = (
  value: string | number | boolean | undefined,
): string | undefined =>
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

function trigger(options: Values, now: number): Trigger | undefined {
  const [cron, timezone, at] = [
    text(options.cron),
    text(options.timezone),
    text(options.at),
  ];
  if (cron && timezone) return { triggerType: "schedule", cron, timezone };
  if (at) {
    const runAt = Date.parse(at);
    if (Number.isNaN(runAt))
      fail("--at must be a valid date/time, preferably ISO 8601.");
    if (runAt <= now) fail("--at must be in the future.");
    return { triggerType: "once", runAt };
  }
  if (typeof options.in === "number") {
    return { triggerType: "once", runAt: now + options.in };
  }
  return undefined;
}

function environment(
  options: Values,
  hostId: string | undefined,
): AgentExecution["environment"] | undefined {
  const reuse = text(options.environment);
  const fresh = text(options["new-environment"]);
  const base = text(options["base-branch"]);
  const host = hostId ? { hostId } : {};
  if (fresh) {
    const baseBranch = base
      ? { kind: "named" as const, name: base }
      : { kind: "default" as const };
    return {
      type: "host",
      ...host,
      workspace: { type: "managed-worktree", baseBranch },
    };
  }
  if (!reuse) return undefined;
  if (reuse.includes("/") || reuse.startsWith(".") || reuse.startsWith("~")) {
    return {
      type: "host",
      ...host,
      workspace: { type: "unmanaged", path: reuse },
    };
  }
  return { type: "reuse", environmentId: reuse };
}

const SCRIPT_ONLY = [
  "interpreter",
  "timeout",
  "env-json",
  "working-directory",
] as const;
const AGENT_ONLY = ["prompt", "provider", "model"] as const;
const EXTENSIONS: Record<string, ScriptExecution["interpreter"]> = {
  sh: "bash",
  bash: "bash",
  js: "node",
  mjs: "node",
  cjs: "node",
  py: "python3",
};

function workingDirectory(raw: string): WorkingDirectory {
  if (raw === "automation-storage" || raw === "project") return { type: raw };
  if (isAbsolute(raw)) return { type: "path", path: raw };
  return fail(
    "Invalid --working-directory. Expected automation-storage, project, or an absolute path on the machine.",
  );
}

function envOf(raw: string): Record<string, string> {
  try {
    return z.record(z.string(), z.string()).parse(JSON.parse(raw));
  } catch {
    return fail("--env-json must be a JSON object of string values.");
  }
}

function agentPatch(
  options: Values,
  hostId: string | undefined,
): Partial<AgentExecution> {
  const env = environment(options, hostId);
  const patch: Partial<AgentExecution> = {};
  const prompt = text(options.prompt);
  const providerId = text(options.provider);
  const model = text(options.model);
  const reasoning = text(options.reasoning);
  const permission = text(options["permission-mode"]);
  const serviceTier = text(options["service-tier"]);
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

const has = (options: Values, names: readonly string[]) =>
  names.some((name) => options[name as keyof Values] !== undefined);

function newAgent(
  options: Values,
  hostId: string | undefined,
  permissionMode: PermissionMode,
): AgentExecution {
  if (has(options, SCRIPT_ONLY)) {
    fail(
      "Agent automations do not accept --interpreter, --timeout, --env-json, or --working-directory.",
      "unexpected_argument",
    );
  }
  const patch = agentPatch(options, hostId);
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
    permissionMode,
    environment: { type: "project-default" },
    ...patch,
    mode: "agent",
  };
}

function changedAgent(
  current: AgentExecution,
  options: Values,
  hostId: string | undefined,
): AgentExecution | undefined {
  const patch = agentPatch(options, hostId);
  const clear = options["clear-service-tier"] === true;
  if (Object.keys(patch).length === 0 && !clear) return undefined;
  const next: AgentExecution = { ...current, ...patch };
  if (patch.targetThreadId) next.environment = { type: "project-default" };
  if (patch.environment) delete next.targetThreadId;
  if (clear) delete next.serviceTier;
  return next;
}

function scriptPatch(options: Values): Partial<ScriptExecution> {
  const patch: Partial<ScriptExecution> = {};
  const interpreter = text(options.interpreter);
  const directory = text(options["working-directory"]);
  const env = text(options["env-json"]);
  if (interpreter) patch.interpreter = z.enum(INTERPRETERS).parse(interpreter);
  if (typeof options.timeout === "number") patch.timeoutMs = options.timeout;
  if (env) patch.env = envOf(env);
  if (directory) patch.workingDirectory = workingDirectory(directory);
  return patch;
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
    ...(execution.mode === "agent"
      ? [
          ["Mode", "agent"],
          ["Provider", `${execution.providerId} / ${execution.model}`],
          ["Target", execution.targetThreadId ?? execution.environment.type],
          ["Prompt", execution.prompt],
        ]
      : [
          ["Mode", "script"],
          ["Interpreter", execution.interpreter ?? "bash"],
          ["Timeout", `${execution.timeoutMs}ms`],
          ["Working directory", execution.workingDirectory.type],
          ["Script", execution.scriptFile ?? execution.script],
        ]),
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

export async function defaultHost(
  bb: PluginServerApi,
  projectId: string,
): Promise<string> {
  const project = await bb.call(projects.get, { projectId });
  const source = project.sources[0];
  if (source) return source.hostId;
  const [first] = await bb.call(machines.list, {});
  if (!first) return fail("No machine is connected.", "unavailable");
  return first.id;
}

export function registerCli(bb: PluginServerApi): void {
  const call = bb.call.bind(bb);

  async function scriptSource(options: Values, ctx: CliContext) {
    const inline = text(options.script);
    if (inline) return { script: inline };
    const file = text(options["script-file"]);
    if (!file) return undefined;
    const hostId = text(options.host) ?? ctx.hostId;
    if (!hostId) return fail("--script-file needs --host <id>.");
    const path = isAbsolute(file) ? file : resolve(ctx.cwd ?? "/", file);
    const read = await bb.runners.call(hostId, machineFiles.read, { path });
    if (!("content" in read) || read.contentEncoding !== "utf8") {
      return fail(`--script-file is not UTF-8 text: ${path}`);
    }
    const interpreter = EXTENSIONS[extname(path).slice(1)];
    return {
      script: read.content,
      scriptFile: path,
      hostId,
      ...(interpreter ? { interpreter } : {}),
    };
  }

  async function bestPermission(providerId: string): Promise<PermissionMode> {
    const options = await call(sessions.executionOptions, { providerId });
    const modes = options.providers.find((each) => each.id === providerId)
      ?.capabilities.permissionModes;
    if (!modes || modes.includes("auto")) return "auto";
    return modes.includes("full") ? "full" : (modes[0] ?? "auto");
  }

  const hostOf = async (options: Values, ctx: CliContext, projectId: string) =>
    ctx.hostId ??
    (text(options.environment) || text(options["new-environment"])
      ? await defaultHost(bb, projectId)
      : undefined);

  async function newExecution(
    options: Values,
    ctx: CliContext,
    projectId: string,
  ): Promise<Execution> {
    const source = await scriptSource(options, ctx);
    if (!source) {
      const providerId = text(options.provider);
      const permission = providerId ? await bestPermission(providerId) : "auto";
      return newAgent(
        options,
        await hostOf(options, ctx, projectId),
        permission,
      );
    }
    if (has(options, AGENT_ONLY)) {
      fail(
        "Script automations do not accept --prompt, --provider or --model.",
        "unexpected_argument",
      );
    }
    return {
      mode: "script",
      timeoutMs: SCRIPT_TIMEOUT_DEFAULT_MS,
      workingDirectory: { type: "automation-storage" },
      ...(ctx.hostId ? { hostId: ctx.hostId } : {}),
      ...source,
      ...scriptPatch(options),
    };
  }

  async function changedExecution(
    current: Automation,
    options: Values,
    ctx: CliContext,
  ): Promise<Execution | undefined> {
    const execution = current.execution;
    const switches =
      execution.mode === "agent"
        ? has(options, ["script", "script-file"])
        : AGENT_ONLY.every((name) => options[name] !== undefined);
    if (switches) return newExecution(options, ctx, current.projectId);
    if (execution.mode === "agent") {
      if (has(options, ["script", "script-file", ...SCRIPT_ONLY])) {
        fail(
          "Agent automations do not accept --interpreter, --timeout, --env-json, or --working-directory.",
          "unexpected_argument",
        );
      }
      return changedAgent(
        execution,
        options,
        await hostOf(options, ctx, current.projectId),
      );
    }
    if (has(options, AGENT_ONLY)) {
      fail(
        "Script automations do not accept --prompt, --provider or --model.",
        "unexpected_argument",
      );
    }
    const patch = {
      ...(await scriptSource(options, ctx)),
      ...scriptPatch(options),
    };
    if (Object.keys(patch).length === 0) return undefined;
    return { ...execution, ...patch };
  }
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
          constraints: [
            { kind: "exactly-one", options: ["cron", "at", "in"] },
            ...SCHEDULE_RULES,
            ...TARGET_RULES,
          ],
          run: async ({ options }, ctx) => {
            const when = trigger(options, bb.now());
            if (!when) return fail("Choose one of --cron, --at or --in.");
            const projectId = projectOf(options.project, ctx);
            const created = await call(automations.create, {
              projectId,
              name: options.name,
              enabled: !options.disabled,
              trigger: when,
              execution: await newExecution(options, ctx, projectId),
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
          constraints: [
            { kind: "at-most-one", options: ["cron", "at", "in"] },
            ...SCHEDULE_RULES,
            ...TARGET_RULES,
          ],
          run: async ({ options, positionals }, ctx) => {
            const ref = {
              projectId: projectOf(options.project, ctx),
              automationId: positionals.automationId,
            };
            const current = await call(automations.get, ref);
            const when = trigger(options, bb.now());
            const execution = await changedExecution(current, options, ctx);
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
            cursor: {
              type: "string",
              placeholder: "cursor",
              description: "Read the page after this nextCursor",
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
              ...(options.cursor ? { cursor: options.cursor } : {}),
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
