import { createHash, randomBytes } from "node:crypto";
import { threads, toolError, type PluginServerApi } from "@bb/plugin";
import { z } from "zod";
import {
  workflows,
  type RunStatus,
  type WorkflowCall,
  type WorkflowRun,
} from "./contract.js";
import { parseWorkflow, runScript } from "./script.js";

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
];

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
    if (options.schema !== undefined) {
      throw new Error("agent() schema results are not supported yet");
    }
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
      settleCall(run.id, index, "succeeded", text, null);
      return text;
    }
    const prior =
      own === undefined && !execution.diverged && run.resumedFromRunId
        ? getCall(run.resumedFromRunId, index)
        : undefined;
    const reuse = prior?.key === key && prior.status === "succeeded";
    if (!reuse) execution.diverged = true;
    db.prepare(
      `INSERT OR REPLACE INTO calls (run_id, call_index, key, label, phase,
       prompt, thread_id, status, cached, result_json, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input: [{ type: "text", text: prompt, mentions: [] }],
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
      settleCall(run.id, index, "succeeded", text, null);
      return text;
    } catch (error) {
      if (!abort.signal.aborted) {
        settleCall(run.id, index, "failed", null, message(error));
      }
      throw error;
    } finally {
      release();
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
      const { body } = parseWorkflow(run.source);
      const result = await runScript(body, {
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
      });
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

  bb.implement(workflows.create, async (input, { caller }) => {
    if (input.script !== undefined && input.source !== undefined) {
      return toolError("Provide either `script` or `source`, not both");
    }
    const source = input.script ?? input.source;
    if (source === undefined) return toolError("Provide a workflow `script`");
    if (caller.thread === null) {
      return toolError("Workflows start from an agent thread");
    }
    const origin = await bb.call(threads.get, { threadId: caller.thread });
    let meta;
    try {
      meta = parseWorkflow(source).meta;
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
