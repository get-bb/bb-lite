import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import {
  environments,
  machines,
  threads,
  toolError,
  type PluginServerApi,
} from "@bb/plugin";
import { z } from "zod";
import {
  structuredWorkers,
  workflows,
  type RunStatus,
  type WorkflowCall,
  type WorkflowRun,
} from "./contract.js";
import { parseWorkflow, runScript } from "./script.js";
import { compileSchema, type Validator } from "./validation.js";

const MAX_AGENT_CALLS = 200;
const MAX_CONCURRENCY = 8;

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
];

const MAX_REPAIRS = 2;
const MAX_SOURCE_BYTES = 512 * 1024;

interface RunRow {
  id: string;
  projectId: string;
  originThreadId: string | null;
  environmentId: string | null;
  providerId: string | null;
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
  resultJson: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

const RUN_COLUMNS = `id, project_id AS projectId, origin_thread_id AS originThreadId,
  environment_id AS environmentId, provider_id AS providerId, name, description,
  source, args_json AS argsJson, status, phase,
  resumed_from_run_id AS resumedFromRunId, result_json AS resultJson, error,
  created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt`;
const CALL_COLUMNS = `call_index AS callIndex, key, label, phase, prompt,
  thread_id AS threadId, status, cached, result_json AS resultJson, error,
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
    result: parseJson(row.resultJson),
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  });

  function requireRun(runId: string): RunRow {
    const row = getRun(runId);
    if (row === undefined) throw new Error(`Unknown workflow run ${runId}`);
    return row;
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
    while (execution.active >= MAX_CONCURRENCY) {
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
    if (index >= MAX_AGENT_CALLS) {
      throw new Error(`A workflow may make at most ${MAX_AGENT_CALLS} calls`);
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
       schema_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
    touched();
    if (reuse) return parseJson(prior.resultJson);
    const release = await slot(execution);
    try {
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
      if (validate) structuredWorkers.add(thread.id);
      const text = await waitFor(thread.id, abort.signal);
      const value = validate
        ? await structured(
            run.id,
            index,
            thread.id,
            text,
            validate,
            abort.signal,
          )
        : text;
      settleCall(run.id, index, "succeeded", value, null);
      return value;
    } catch (error) {
      if (!abort.signal.aborted) {
        settleCall(run.id, index, "failed", null, message(error));
      }
      throw error;
    } finally {
      release();
    }
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
    structuredWorkers.add(threadId);
    try {
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
    } finally {
      structuredWorkers.delete(threadId);
    }
  }

  function finish(
    runId: string,
    status: RunStatus,
    result: unknown,
    error: string | null,
  ) {
    db.prepare(
      `UPDATE runs SET status = ?, result_json = ?, error = ?, finished_at = ?
       WHERE id = ?`,
    ).run(
      status,
      result === null ? null : JSON.stringify(result),
      error,
      bb.now(),
      runId,
    );
    touched();
    const run = getRun(runId);
    if (run?.originThreadId == null) return;
    const outcome =
      status === "succeeded"
        ? "finished"
        : `${status}${error ? `: ${error}` : ""}`;
    const text = `Workflow ${run.name} (${run.id}) ${outcome}. Run \`bb workflows status ${run.id}\` for its result.`;
    bb.call(threads.send, {
      threadId: run.originThreadId,
      input: [{ type: "text", text, mentions: [] }],
      mode: "queue-if-active",
    }).catch((failure: unknown) =>
      bb.log.warn("Workflow notification failed", { error: message(failure) }),
    );
  }

  async function execute(runId: string) {
    const run = getRun(runId);
    if (run === undefined || TERMINAL.includes(run.status)) return;
    if (executions.has(runId)) return;
    const execution: Execution = {
      run,
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
    try {
      const { body, meta } = parseWorkflow(run.source);
      const result = await runScript(
        body,
        {
          args: parseJson(run.argsJson),
          agent: (prompt, options) => agent(execution, prompt, options),
          phase: (title) => {
            execution.phase = String(title);
            db.prepare("UPDATE runs SET phase = ? WHERE id = ?").run(
              execution.phase,
              runId,
            );
            touched();
          },
          log: (text) => bb.log.info(String(text), { runId }),
          budget: () => ({
            maxAgentCalls: MAX_AGENT_CALLS,
            concurrency: MAX_CONCURRENCY,
          }),
        },
        execution.abort.signal,
      );
      const invalid =
        meta.outputSchema === undefined
          ? null
          : compileSchema(meta.outputSchema, "meta.outputSchema")(result);
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

  async function resolveSource(
    input: z.infer<typeof workflows.validate.input>,
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
    const path = posix.resolve(
      root,
      input.name ? `.bb/workflows/${input.name}.js` : (input.scriptPath ?? ""),
    );
    if (path !== root && !path.startsWith(`${root}/`)) {
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

  bb.implement(workflows.validate, async (input, { caller }) => {
    const { meta } = parseWorkflow(await resolveSource(input, caller.thread));
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
  });

  bb.implement(workflows.create, async (input, { caller }) => {
    if (caller.thread === null) {
      return toolError("Workflows start from an agent thread");
    }
    let source: string;
    try {
      source = await resolveSource(input, caller.thread);
      if (caller.door === "cli" && typeof input.args === "string") {
        input = { ...input, args: JSON.parse(input.args) as unknown };
      }
    } catch (error) {
      return toolError(message(error));
    }
    const origin = await bb.call(threads.get, { threadId: caller.thread });
    let meta;
    try {
      meta = parseWorkflow(source).meta;
      const invalid =
        meta.inputSchema === undefined
          ? null
          : compileSchema(
              meta.inputSchema,
              "meta.inputSchema",
            )(input.args ?? null);
      if (invalid !== null) throw new Error(`Invalid args: ${invalid}`);
      if (meta.outputSchema !== undefined) {
        compileSchema(meta.outputSchema, "meta.outputSchema");
      }
    } catch (error) {
      return toolError(message(error));
    }
    const resumed = input.resumeRunId ? getRun(input.resumeRunId) : undefined;
    if (input.resumeRunId && resumed === undefined) {
      return toolError(`Unknown workflow run ${input.resumeRunId}`);
    }
    if (resumed && !TERMINAL.includes(resumed.status)) {
      return toolError("Only a finished run can be resumed");
    }
    if (resumed && resumed.projectId !== origin.projectId) {
      return toolError("The resumed run is from another project");
    }
    const runId = `wfr_${randomBytes(9).toString("base64url")}`;
    db.prepare(
      `INSERT INTO runs (id, project_id, origin_thread_id, environment_id,
       provider_id, name, description, source, source_hash, args_json, status,
       resumed_from_run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ).run(
      runId,
      origin.projectId,
      origin.id,
      origin.environmentId,
      origin.providerId,
      meta.name,
      meta.description,
      source,
      createHash("sha256").update(source).digest("hex"),
      JSON.stringify(input.args ?? null),
      input.resumeRunId ?? null,
      bb.now(),
    );
    touched();
    void execute(runId);
    return {
      runId,
      status: "queued" as const,
      name: meta.name,
      previewDirective: `::workflow-preview{run="${runId}"}`,
    };
  });

  bb.implement(workflows.result, ({ value }, { caller }) => {
    const row =
      caller.thread === null
        ? undefined
        : (db
            .prepare(
              `SELECT run_id, call_index, schema_json FROM calls
               WHERE thread_id = ? AND status = 'running'
               AND schema_json IS NOT NULL`,
            )
            .get(caller.thread) as
            | { run_id: string; call_index: number; schema_json: string }
            | undefined);
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
  });

  bb.implement(workflows.get, ({ runId }) => view(requireRun(runId)));

  bb.implement(workflows.list, ({ threadId }) => {
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
    return rows.map(view);
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

  bb.onStart(() => {
    const pending = db
      .prepare("SELECT id FROM runs WHERE status IN ('queued', 'running')")
      .all() as { id: string }[];
    for (const { id } of pending) void execute(id);
    return () => {
      for (const execution of executions.values()) execution.abort.abort();
    };
  });
}
