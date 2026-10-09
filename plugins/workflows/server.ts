import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  environments,
  fail,
  machines,
  threads,
  toolError,
  type PluginServerApi,
} from "@bb/plugin";
import { z } from "zod";
import {
  workflows,
  type RunStatus,
  type WorkflowCall,
  type WorkflowRun,
} from "./contract.js";
import { parseWorkflow, runScript, type ScriptGlobals } from "./script.js";
import {
  clampLimits,
  clipUtf8,
  isTransient,
  RETRY_DELAYS_MS,
  SETTINGS,
  type Limits,
} from "./policy.js";
import { compileSchema, type Validator } from "./validation.js";

const NOTIFY_ATTEMPTS = 10;
const sourceName = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .max(64);
const SWEEP_MS = 60 * 60 * 1000;

const MIGRATIONS = [
  `CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    origin_thread_id TEXT,
    environment_id TEXT,
    provider_id TEXT,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    source TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    args_json TEXT NOT NULL,
    status TEXT NOT NULL,
    phase TEXT,
    resumed_from_run_id TEXT,
    result_json TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
  )`,
  `CREATE TABLE calls (
    run_id TEXT NOT NULL,
    call_index INTEGER NOT NULL,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    phase TEXT,
    prompt TEXT NOT NULL,
    thread_id TEXT,
    status TEXT NOT NULL,
    cached INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    error TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    PRIMARY KEY (run_id, call_index)
  )`,
  `ALTER TABLE calls ADD COLUMN schema_json TEXT;
   ALTER TABLE calls ADD COLUMN structured_json TEXT;`,
  `ALTER TABLE runs ADD COLUMN settings_json TEXT;
   ALTER TABLE runs ADD COLUMN notification_status TEXT;
   ALTER TABLE runs ADD COLUMN notification_attempts INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE runs ADD COLUMN notification_error TEXT;
   ALTER TABLE calls ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;`,
];

const MAX_REPAIRS = 2;
const MAX_SOURCE_BYTES = 512 * 1024;

interface RunRow {
  id: string;
  projectId: string;
  originThreadId: string | null;
  environmentId: string | null;
  providerId: string | null;
  settingsJson: string | null;
  notificationStatus: "pending" | "sent" | "failed" | null;
  notificationAttempts: number;
  notificationError: string | null;
  name: string;
  description: string;
  source: string;
  argsJson: string;
  status: RunStatus;
  phase: string | null;
  resumedFromRunId: string | null;
  resultJson: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

interface CallRow {
  callIndex: number;
  key: string;
  label: string;
  phase: string | null;
  prompt: string;
  threadId: string | null;
  status: WorkflowCall["status"];
  cached: number;
  attempts: number;
  resultJson: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

const RUN_COLUMNS = `id, project_id AS projectId, origin_thread_id AS originThreadId,
  environment_id AS environmentId, provider_id AS providerId, name, description,
  source, args_json AS argsJson, status, phase,
  resumed_from_run_id AS resumedFromRunId, result_json AS resultJson, error,
  created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt,
  settings_json AS settingsJson,
  notification_status AS notificationStatus,
  notification_attempts AS notificationAttempts,
  notification_error AS notificationError`;
const CALL_COLUMNS = `call_index AS callIndex, key, label, phase, prompt,
  thread_id AS threadId, status, cached, attempts, result_json AS resultJson, error,
  started_at AS startedAt, finished_at AS finishedAt`;

const agentOptionsSchema = z
  .object({
    label: z.string().min(1).optional(),
    phase: z.string().min(1).optional(),
    schema: z.unknown().optional(),
  })
  .passthrough();

interface Execution {
  run: RunRow;
  limits: Limits;
  abort: AbortController;
  next: number;
  diverged: boolean;
  phase: string | null;
  active: number;
  waiting: (() => void)[];
}

interface Waiter {
  resolve(text: string): void;
  reject(error: Error): void;
}

const TERMINAL: readonly RunStatus[] = ["succeeded", "failed", "cancelled"];
const parseJson = (text: string | null): unknown =>
  text === null ? null : JSON.parse(text);
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export default function workflowsServer(bb: PluginServerApi): void {
  const db = bb.storage.database(MIGRATIONS);
  const settings = bb.settings.define(SETTINGS);
  const executions = new Map<string, Execution>();
  const waiters = new Map<string, Waiter>();
  const early = new Map<string, { text?: string; error?: string }>();

  const getRun = (runId: string) =>
    db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`).get(runId) as
      | RunRow
      | undefined;
  const getCall = (runId: string, index: number) =>
    db
      .prepare(
        `SELECT ${CALL_COLUMNS} FROM calls WHERE run_id = ? AND call_index = ?`,
      )
      .get(runId, index) as CallRow | undefined;
  const callsOf = (runId: string, from = 0, limit = -1) =>
    db
      .prepare(
        `SELECT ${CALL_COLUMNS} FROM calls WHERE run_id = ? AND call_index >= ?
         ORDER BY call_index LIMIT ?`,
      )
      .all(runId, from, limit) as CallRow[];

  const touched = () => {
    bb.changed(workflows.get);
    bb.changed(workflows.list);
    bb.changed(workflows.history);
  };

  function view(row: RunRow): WorkflowRun {
    const counts = db
      .prepare(
        "SELECT status, COUNT(*) AS n FROM calls WHERE run_id = ? GROUP BY status",
      )
      .all(row.id) as { status: string; n: number }[];
    return {
      id: row.id,
      projectId: row.projectId,
      originThreadId: row.originThreadId,
      environmentId: row.environmentId,
      name: row.name,
      description: row.description,
      status: row.status,
      phase: row.phase,
      resumedFromRunId: row.resumedFromRunId,
      result: parseJson(row.resultJson),
      error: row.error,
      calls: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      originProviderId: row.providerId,
      settings: limitsOf(row),
      notification: {
        status: row.notificationStatus,
        attempts: row.notificationAttempts,
        error: row.notificationError,
      },
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
  }

  const callView = (row: CallRow): WorkflowCall => ({
    index: row.callIndex,
    label: row.label,
    phase: row.phase,
    prompt: row.prompt,
    threadId: row.threadId,
    status: row.status,
    cached: row.cached === 1,
    attempts: row.attempts,
    result: parseJson(row.resultJson),
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  });

  function requireRun(runId: string): RunRow {
    const row = getRun(runId);
    if (row === undefined) fail("not_found", `Unknown workflow run ${runId}`);
    return row;
  }

  function limitsOf(row: RunRow): Limits {
    const saved = row.settingsJson === null ? {} : parseJson(row.settingsJson);
    const defaults = Object.fromEntries(
      Object.entries(SETTINGS).map(([key, field]) => [key, field.default]),
    ) as Limits;
    return clampLimits({ ...defaults, ...(saved as Partial<Limits>) });
  }

  function settleCall(
    runId: string,
    index: number,
    status: WorkflowCall["status"],
    result: unknown,
    error: string | null,
  ) {
    db.prepare(
      `UPDATE calls SET status = ?, result_json = ?, error = ?, finished_at = ?
       WHERE run_id = ? AND call_index = ?`,
    ).run(
      status,
      result === null ? null : JSON.stringify(result),
      error,
      bb.now(),
      runId,
      index,
    );
    touched();
  }

  function waitFor(threadId: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const done = early.get(threadId);
      if (done !== undefined) {
        early.delete(threadId);
        if (done.error === undefined) resolve(done.text ?? "");
        else reject(new Error(done.error));
        return;
      }
      const onAbort = () => {
        waiters.delete(threadId);
        reject(new Error("Workflow stopped"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const clear = () => {
        waiters.delete(threadId);
        signal.removeEventListener("abort", onAbort);
      };
      waiters.set(threadId, {
        resolve: (text) => {
          clear();
          resolve(text);
        },
        reject: (error) => {
          clear();
          reject(error);
        },
      });
    });
  }

  async function resumeWait(threadId: string, signal: AbortSignal) {
    const waiting = waitFor(threadId, signal);
    const thread = await bb.call(threads.get, { threadId });
    const { output } = await bb.call(threads.output, { threadId });
    if (thread.status === "idle" && output !== null) {
      waiters.get(threadId)?.resolve(output);
    } else if (thread.status === "error") {
      waiters.get(threadId)?.reject(new Error("Worker thread failed"));
    }
    return waiting;
  }

  async function slot(execution: Execution) {
    while (execution.active >= execution.limits.maxConcurrentAgents) {
      await new Promise<void>((resolve) => execution.waiting.push(resolve));
    }
    execution.active += 1;
    return () => {
      execution.active -= 1;
      execution.waiting.shift()?.();
    };
  }

  async function agent(
    execution: Execution,
    promptInput: unknown,
    optionsInput: unknown,
  ): Promise<unknown> {
    const { run, abort } = execution;
    const prompt = z.string().min(1).parse(promptInput);
    const options = agentOptionsSchema.parse(optionsInput ?? {});
    const validate =
      options.schema === undefined
        ? undefined
        : compileSchema(options.schema, "agent schema");
    const index = execution.next;
    execution.next += 1;
    const { maxAgentCalls } = execution.limits;
    if (index >= maxAgentCalls) {
      throw new Error(`A workflow may make at most ${maxAgentCalls} calls`);
    }
    const phase = options.phase ?? execution.phase;
    const label = options.label ?? prompt.slice(0, 80);
    const key = createHash("sha256")
      .update(JSON.stringify([prompt, options.schema ?? null]))
      .digest("hex");
    const own = getCall(run.id, index);
    if (own?.key === key && own.status === "succeeded") {
      return parseJson(own.resultJson);
    }
    if (own?.key === key && own.status === "running" && own.threadId) {
      const text = await resumeWait(own.threadId, abort.signal);
      const value = validate
        ? await structured(
            run.id,
            index,
            own.threadId,
            text,
            validate,
            abort.signal,
          )
        : text;
      settleCall(run.id, index, "succeeded", value, null);
      return value;
    }
    const prior =
      own === undefined && !execution.diverged && run.resumedFromRunId
        ? getCall(run.resumedFromRunId, index)
        : undefined;
    const reuse = prior?.key === key && prior.status === "succeeded";
    if (!reuse) execution.diverged = true;
    db.prepare(
      `INSERT OR REPLACE INTO calls (run_id, call_index, key, label, phase,
       prompt, thread_id, status, cached, result_json, started_at, finished_at,
       schema_json, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.id,
      index,
      key,
      label,
      phase,
      prompt,
      reuse ? prior.threadId : null,
      reuse ? "succeeded" : "running",
      reuse ? 1 : 0,
      reuse ? prior.resultJson : null,
      bb.now(),
      reuse ? bb.now() : null,
      options.schema === undefined ? null : JSON.stringify(options.schema),
      own?.key === key ? own.attempts : 0,
    );
    touched();
    if (reuse) return parseJson(prior.resultJson);
    const release = await slot(execution);
    try {
      for (let attempt = own?.key === key ? own.attempts : 0; ; attempt += 1) {
        try {
          return await live(execution, index, prompt, label, options, validate);
        } catch (error) {
          const delay = RETRY_DELAYS_MS[attempt];
          if (
            abort.signal.aborted ||
            delay === undefined ||
            !isTransient(message(error))
          ) {
            throw error;
          }
          db.prepare(
            `UPDATE calls SET attempts = ?, thread_id = NULL
             WHERE run_id = ? AND call_index = ?`,
          ).run(attempt + 1, run.id, index);
          touched();
          bb.log.warn("Retrying workflow agent call", {
            runId: run.id,
            index,
            error: message(error),
          });
          await sleep(delay, undefined, { signal: abort.signal });
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        settleCall(run.id, index, "failed", null, message(error));
      }
      throw error;
    } finally {
      release();
    }
  }

  async function live(
    execution: Execution,
    index: number,
    prompt: string,
    label: string,
    options: z.infer<typeof agentOptionsSchema>,
    validate: Validator | undefined,
  ): Promise<unknown> {
    const { run, abort } = execution;
    abort.signal.throwIfAborted();
    const thread = await bb.call(threads.create, {
      projectId: run.projectId,
      origin: "plugin",
      originPluginId: bb.pluginId,
      visibility: "hidden",
      title: label,
      providerId: run.providerId ?? undefined,
      input: [
        {
          type: "text",
          text:
            options.schema === undefined
              ? prompt
              : `${prompt}\n\nUse bb_workflow_result to return your final response in the requested structured format. You MUST call this tool exactly once at the end of your response with {"value": ...}. The value must satisfy this JSON Schema:\n${JSON.stringify(options.schema, null, 2)}\nIf the tool is unavailable, return only the JSON value in your final response as a fallback. If the tool reports validation errors, correct the value and retry. You have at most ${MAX_REPAIRS} corrective retries.`,
          mentions: [],
        },
      ],
      environment: run.environmentId
        ? { type: "reuse", environmentId: run.environmentId }
        : { type: "project-default" },
      startedOnBehalfOf: null,
    });
    db.prepare(
      "UPDATE calls SET thread_id = ? WHERE run_id = ? AND call_index = ?",
    ).run(thread.id, run.id, index);
    touched();
    const text = await waitFor(thread.id, abort.signal);
    const value = validate
      ? await structured(run.id, index, thread.id, text, validate, abort.signal)
      : text;
    settleCall(run.id, index, "succeeded", value, null);
    return value;
  }

  function submitted(runId: string, index: number, text: string) {
    const row = db
      .prepare(
        "SELECT structured_json FROM calls WHERE run_id = ? AND call_index = ?",
      )
      .get(runId, index) as { structured_json: string | null } | undefined;
    if (row?.structured_json != null) {
      return { value: parseJson(row.structured_json) };
    }
    try {
      return { value: JSON.parse(text) as unknown };
    } catch {
      return undefined;
    }
  }

  async function structured(
    runId: string,
    index: number,
    threadId: string,
    first: string,
    validate: Validator,
    signal: AbortSignal,
  ): Promise<unknown> {
    let text = first;
    for (let attempt = 1; ; attempt += 1) {
      const outcome = submitted(runId, index, text);
      const detail =
        outcome === undefined
          ? "no bb_workflow_result call and the final response is not JSON"
          : validate(outcome.value);
      if (outcome !== undefined && detail === null) return outcome.value;
      if (attempt > MAX_REPAIRS) {
        throw new Error(
          `Structured output failed after ${MAX_REPAIRS} corrective retries: ${detail}`,
        );
      }
      const waiting = waitFor(threadId, signal);
      await bb.call(threads.send, {
        threadId,
        input: [
          {
            type: "text",
            text: `Structured result missing or invalid (${detail}). Call bb_workflow_result with one value matching the required schema. Corrective turn ${attempt} of ${MAX_REPAIRS}.`,
            mentions: [],
          },
        ],
        mode: "queue-if-active",
      });
      text = await waiting;
    }
  }

  function finish(
    runId: string,
    status: RunStatus,
    result: unknown,
    error: string | null,
  ) {
    db.prepare(
      `UPDATE runs SET status = ?, result_json = ?, error = ?, finished_at = ?,
       notification_status = CASE WHEN origin_thread_id IS NULL THEN NULL
       ELSE 'pending' END
       WHERE id = ?`,
    ).run(
      status,
      result === null ? null : JSON.stringify(result),
      error,
      bb.now(),
      runId,
    );
    touched();
    void notify(runId);
  }

  const notifyTimers = new Set<ReturnType<typeof setTimeout>>();

  async function notify(runId: string) {
    const run = getRun(runId);
    if (run?.originThreadId == null || run.notificationStatus !== "pending") {
      return;
    }
    const outcome =
      run.status === "succeeded"
        ? "finished"
        : `${run.status}${run.error ? `: ${run.error}` : ""}`;
    const text = clipUtf8(
      `Workflow ${run.name} (${run.id}) ${outcome}. Run \`bb workflows status ${run.id}\` for its result.`,
      limitsOf(run).maxNotificationBytes,
    );
    const attempts = run.notificationAttempts + 1;
    try {
      await bb.call(threads.send, {
        threadId: run.originThreadId,
        input: [{ type: "text", text, mentions: [] }],
        mode: "queue-if-active",
      });
      db.prepare(
        `UPDATE runs SET notification_status = 'sent',
         notification_attempts = ?, notification_error = NULL WHERE id = ?`,
      ).run(attempts, runId);
    } catch (failure) {
      const final = attempts >= NOTIFY_ATTEMPTS;
      db.prepare(
        `UPDATE runs SET notification_status = ?, notification_attempts = ?,
         notification_error = ? WHERE id = ?`,
      ).run(final ? "failed" : "pending", attempts, message(failure), runId);
      if (!final) {
        const timer = setTimeout(
          () => {
            notifyTimers.delete(timer);
            void notify(runId);
          },
          Math.min(1000 * 2 ** (attempts - 1), SWEEP_MS),
        );
        notifyTimers.add(timer);
      }
    }
    touched();
  }

  const queue: string[] = [];

  function execute(runId: string) {
    const run = getRun(runId);
    if (run === undefined || TERMINAL.includes(run.status)) return;
    if (executions.has(runId) || queue.includes(runId)) return;
    if (executions.size >= limitsOf(run).maxActiveRuns) {
      queue.push(runId);
      return;
    }
    void start(run).finally(() => {
      const next = queue.shift();
      if (next !== undefined) execute(next);
    });
  }

  function globalsFor(
    execution: Execution,
    args: unknown,
    nested: boolean,
  ): ScriptGlobals {
    return {
      args,
      agent: (prompt, options) => agent(execution, prompt, options),
      workflow: (reference, childArgs) =>
        nested
          ? Promise.reject(
              new Error(
                "Nested workflow depth limit exceeded: workflows may invoke one child level only",
              ),
            )
          : child(execution, reference, childArgs ?? null),
      phase: (title) => {
        execution.phase = String(title);
        db.prepare("UPDATE runs SET phase = ? WHERE id = ?").run(
          execution.phase,
          execution.run.id,
        );
        touched();
      },
      log: (text) => bb.log.info(String(text), { runId: execution.run.id }),
      budget: () => ({
        maxAgentCalls: execution.limits.maxAgentCalls,
        concurrency: execution.limits.maxConcurrentAgents,
      }),
    };
  }

  function checked(source: string, args: unknown) {
    const { body, meta } = parseWorkflow(source);
    const invalid =
      meta.inputSchema === undefined
        ? null
        : compileSchema(meta.inputSchema, "meta.inputSchema")(args);
    if (invalid !== null) throw new Error(`Invalid args: ${invalid}`);
    const output =
      meta.outputSchema === undefined
        ? undefined
        : compileSchema(meta.outputSchema, "meta.outputSchema");
    return { body, meta, output };
  }

  async function child(
    execution: Execution,
    referenceInput: unknown,
    args: unknown,
  ): Promise<unknown> {
    const reference = z
      .union([
        z
          .string()
          .min(1)
          .transform((name) => ({ name })),
        z.object({ name: sourceName }).strict(),
        z.object({ scriptPath: z.string().min(1) }).strict(),
        z.object({ script: z.string().min(1) }).strict(),
      ])
      .parse(referenceInput);
    const source = await resolveSource(reference, execution.run.originThreadId);
    const { body, meta, output } = checked(source, args);
    const result = await runScript(
      body,
      globalsFor(execution, args, true),
      execution.abort.signal,
    );
    const invalid = output?.(result) ?? null;
    if (invalid !== null) {
      throw new Error(
        `Workflow ${meta.name} result does not match outputSchema: ${invalid}`,
      );
    }
    return result;
  }

  async function start(run: RunRow) {
    const runId = run.id;
    const execution: Execution = {
      run,
      limits: limitsOf(run),
      abort: new AbortController(),
      next: 0,
      diverged: false,
      phase: null,
      active: 0,
      waiting: [],
    };
    executions.set(runId, execution);
    db.prepare(
      "UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?",
    ).run(bb.now(), runId);
    touched();
    const startedAt = getRun(runId)?.startedAt ?? bb.now();
    const timeout = setTimeout(
      () => {
        if (execution.abort.signal.aborted) return;
        execution.abort.abort();
        finish(
          runId,
          "failed",
          null,
          `Workflow run timed out after ${execution.limits.totalRunTimeoutMs} ms`,
        );
      },
      Math.max(0, startedAt + execution.limits.totalRunTimeoutMs - bb.now()),
    );
    try {
      const args = parseJson(run.argsJson);
      const { body, output } = checked(run.source, args);
      const result = await runScript(
        body,
        globalsFor(execution, args, false),
        execution.abort.signal,
      );
      const invalid = output?.(result) ?? null;
      if (invalid !== null) {
        throw new Error(
          `Workflow result does not match outputSchema: ${invalid}`,
        );
      }
      if (!execution.abort.signal.aborted) {
        finish(runId, "succeeded", result, null);
      }
    } catch (error) {
      if (!execution.abort.signal.aborted) {
        finish(runId, "failed", null, message(error));
      }
    } finally {
      clearTimeout(timeout);
      executions.delete(runId);
    }
  }
  bb.on(threads.idle, ({ thread, lastAssistantText }) => {
    if (thread.originPluginId !== bb.pluginId) return;
    const text = lastAssistantText ?? "";
    const waiter = waiters.get(thread.id);
    if (waiter) waiter.resolve(text);
    else early.set(thread.id, { text });
  });
  bb.on(threads.failed, ({ thread, error }) => {
    if (thread.originPluginId !== bb.pluginId) return;
    const failure = error ?? "Worker thread failed";
    const waiter = waiters.get(thread.id);
    if (waiter) waiter.reject(new Error(failure));
    else early.set(thread.id, { error: failure });
  });

  interface SourceInput {
    script?: string;
    source?: string;
    scriptPath?: string;
    name?: string;
    cwd?: string;
  }

  async function resolveSource(
    input: SourceInput,
    threadId: string | null,
  ): Promise<string> {
    const given = [
      input.script,
      input.source,
      input.scriptPath,
      input.name,
    ].filter((value) => value !== undefined);
    if (given.length !== 1) {
      throw new Error(
        "Provide exactly one of `script`, `source`, `scriptPath` or `name`",
      );
    }
    const inline = input.script ?? input.source;
    if (inline !== undefined) return inline;
    const environmentId =
      threadId === null
        ? null
        : (await bb.call(threads.get, { threadId })).environmentId;
    const environment = environmentId
      ? await bb.call(environments.get, { environmentId })
      : null;
    if (environment?.path == null) {
      throw new Error("Workflow files need a thread with a workspace");
    }
    const root = posix.normalize(environment.path);
    const inside = (path: string) =>
      path === root || path.startsWith(`${root}/`);
    const base =
      input.cwd === undefined || input.name !== undefined
        ? root
        : posix.resolve(root, input.cwd);
    if (!inside(base)) {
      throw new Error("Workflow files must stay inside the workspace");
    }
    const path = posix.resolve(
      base,
      input.name ? `.bb/workflows/${input.name}.js` : (input.scriptPath ?? ""),
    );
    if (!inside(path)) {
      throw new Error("Workflow files must stay inside the workspace");
    }
    const file = await bb.call(machines.readFile, {
      hostId: environment.hostId,
      path,
      rootPath: root,
    });
    if (file.sizeBytes > MAX_SOURCE_BYTES) {
      throw new Error(`Workflow source exceeds ${MAX_SOURCE_BYTES} bytes`);
    }
    return file.contentEncoding === "base64"
      ? Buffer.from(file.content, "base64").toString("utf8")
      : file.content;
  }

  const fromDoor = (input: SourceInput, door: string): SourceInput =>
    door === "cli" ? input : { ...input, cwd: undefined };

  const invalid = (error: unknown): never =>
    fail("invalid", message(error), {
      hint: "Run `bb workflows validate` and read the workflows skill",
    });

  bb.implement(workflows.validate, async (input, { caller }) => {
    const origin = caller.thread ?? input.threadId ?? null;
    try {
      const { meta } = parseWorkflow(
        await resolveSource(fromDoor(input, caller.door), origin),
      );
      if (meta.inputSchema !== undefined) {
        compileSchema(meta.inputSchema, "meta.inputSchema");
      }
      if (meta.outputSchema !== undefined) {
        compileSchema(meta.outputSchema, "meta.outputSchema");
      }
      return {
        name: meta.name,
        description: meta.description,
        phases: (meta.phases ?? []).map((phase) => phase.title),
      };
    } catch (error) {
      return invalid(error);
    }
  });

  bb.implement(workflows.create, async (input, { caller }) => {
    const originId = caller.thread ?? input.threadId ?? null;
    if (originId === null) {
      return fail("invalid", "Workflows start from an agent thread", {
        hint: "Run `bb workflows run` from an agent's terminal, or pass --thread-id",
      });
    }
    let source: string;
    let meta;
    try {
      source = await resolveSource(fromDoor(input, caller.door), originId);
      if (caller.door === "cli" && typeof input.args === "string") {
        input = { ...input, args: JSON.parse(input.args) as unknown };
      }
      meta = checked(source, input.args ?? null).meta;
    } catch (error) {
      return invalid(error);
    }
    const origin = await bb.call(threads.get, { threadId: originId });
    const resumed = input.resumeRunId ? getRun(input.resumeRunId) : undefined;
    if (input.resumeRunId && resumed === undefined) {
      return fail("not_found", `Unknown workflow run ${input.resumeRunId}`);
    }
    if (resumed && !TERMINAL.includes(resumed.status)) {
      return fail("conflict", "Only a finished run can be resumed");
    }
    if (resumed && resumed.projectId !== origin.projectId) {
      return fail("invalid", "The resumed run is from another project");
    }
    const limits = clampLimits(await settings.get());
    const runId = `wfr_${randomBytes(9).toString("base64url")}`;
    db.prepare(
      `INSERT INTO runs (id, project_id, origin_thread_id, environment_id,
       provider_id, settings_json, name, description, source,
       source_hash, args_json, status, resumed_from_run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ).run(
      runId,
      origin.projectId,
      origin.id,
      origin.environmentId,
      origin.providerId,
      JSON.stringify(limits),
      meta.name,
      meta.description,
      source,
      createHash("sha256").update(source).digest("hex"),
      JSON.stringify(input.args ?? null),
      input.resumeRunId ?? null,
      bb.now(),
    );
    touched();
    execute(runId);
    return {
      runId,
      status: "queued" as const,
      name: meta.name,
      previewDirective: `::workflow-preview{run="${runId}"}`,
    };
  });

  const awaiting = (threadId: string) =>
    db
      .prepare(
        `SELECT run_id, call_index, schema_json FROM calls
         WHERE thread_id = ? AND status = 'running'
         AND schema_json IS NOT NULL`,
      )
      .get(threadId) as
      | { run_id: string; call_index: number; schema_json: string }
      | undefined;

  bb.implement(
    workflows.result,
    ({ value }, { caller }) => {
      const row = caller.thread === null ? undefined : awaiting(caller.thread);
      if (row === undefined) {
        return toolError("This thread has no workflow call awaiting a result");
      }
      const invalid = compileSchema(JSON.parse(row.schema_json))(value);
      if (invalid !== null) {
        return toolError(
          `Value does not match the required schema (${invalid}). Correct it and retry.`,
        );
      }
      db.prepare(
        "UPDATE calls SET structured_json = ? WHERE run_id = ? AND call_index = ?",
      ).run(JSON.stringify(value ?? null), row.run_id, row.call_index);
      return "Structured result recorded.";
    },
    { offered: ({ threadId }) => awaiting(threadId) !== undefined },
  );
  bb.implement(workflows.get, ({ runId }) => view(requireRun(runId)));

  bb.implement(workflows.list, ({ threadId, limit }) => {
    const rows = (
      threadId === undefined
        ? db
            .prepare(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY created_at DESC`)
            .all()
        : db
            .prepare(
              `SELECT ${RUN_COLUMNS} FROM runs WHERE origin_thread_id = ?
               ORDER BY created_at DESC`,
            )
            .all(threadId)
    ) as RunRow[];
    return rows.slice(0, limit).map(view);
  });

  bb.implement(workflows.history, ({ runId, cursor, limit }) => {
    const run = view(requireRun(runId));
    const page = callsOf(runId, cursor, limit + 1);
    const more = page.length > limit;
    const calls = page.slice(0, limit).map(callView);
    const last = calls.at(-1);
    return { run, calls, nextCursor: more && last ? last.index + 1 : null };
  });

  bb.implement(workflows.stop, async ({ runId }) => {
    const run = requireRun(runId);
    if (TERMINAL.includes(run.status))
      return { stopped: false, run: view(run) };
    executions.get(runId)?.abort.abort();
    const running = callsOf(runId).filter((call) => call.status === "running");
    for (const call of running) {
      settleCall(runId, call.callIndex, "cancelled", null, null);
      if (call.threadId === null) continue;
      await bb
        .call(threads.stop, { threadId: call.threadId })
        .catch(() => undefined);
    }
    finish(runId, "cancelled", null, null);
    return { stopped: true, run: view(requireRun(runId)) };
  });

  async function sweep() {
    const { retentionDays } = clampLimits(await settings.get());
    const cutoff = bb.now() - retentionDays * 86_400_000;
    const expired = db
      .prepare(
        `SELECT id FROM runs WHERE finished_at IS NOT NULL AND finished_at <= ?
         AND (notification_status IS NULL OR notification_status != 'pending')`,
      )
      .all(cutoff) as { id: string }[];
    for (const { id } of expired) {
      const workers = callsOf(id).flatMap((call) =>
        call.threadId === null || call.cached === 1 ? [] : [call.threadId],
      );
      for (const threadId of new Set(workers)) {
        await bb.call(threads.archive, { threadId }).catch((error: unknown) =>
          bb.log.warn("Could not archive workflow worker", {
            threadId,
            error: message(error),
          }),
        );
      }
      db.prepare("DELETE FROM calls WHERE run_id = ?").run(id);
      db.prepare("DELETE FROM runs WHERE id = ?").run(id);
    }
    if (expired.length > 0) touched();
  }

  bb.onStart(() => {
    const pending = db
      .prepare(
        "SELECT id FROM runs WHERE status IN ('queued', 'running') ORDER BY created_at",
      )
      .all() as { id: string }[];
    for (const { id } of pending) execute(id);
    const unsent = db
      .prepare("SELECT id FROM runs WHERE notification_status = 'pending'")
      .all() as { id: string }[];
    for (const { id } of unsent) void notify(id);
    const cleanup = () =>
      sweep().catch((error: unknown) =>
        bb.log.warn("Workflow retention sweep failed", {
          error: message(error),
        }),
      );
    void cleanup();
    const timer = setInterval(() => void cleanup(), SWEEP_MS);
    return () => {
      clearInterval(timer);
      for (const timer of notifyTimers) clearTimeout(timer);
      queue.length = 0;
      for (const execution of executions.values()) execution.abort.abort();
    };
  });
}
