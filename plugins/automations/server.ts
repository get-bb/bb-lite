import {
  deny,
  fail,
  projects,
  threads,
  type PluginServerApi,
} from "@bb/plugin";
import { findLocalPathProjectSourceForHost } from "@bb/domain";
import { defaultHost, registerCli } from "./cli.js";
import {
  RUNS_LIMIT_DEFAULT,
  automations,
  type Automation,
  type Run,
  type ScriptExecution,
  type ScriptResult,
  type Trigger,
} from "./contract.js";
import { nextRunAt, openStore, validateTrigger } from "./store.js";

const SWEEP_INTERVAL_MS = 1000;
const FAILURE_DETAIL_MAX = 200;

function firstLine(text: string): string | null {
  const line = text
    .split(/\r?\n/u)
    .map((each) => each.replace(/\p{Cc}/gu, " ").trim())
    .find(Boolean);
  if (!line) return null;
  return line.length > FAILURE_DETAIL_MAX
    ? `${line.slice(0, FAILURE_DETAIL_MAX - 1)}\u2026`
    : line;
}

function wakeAgentOff(output: string): boolean {
  const last = output.trim().split(/\r?\n/u).at(-1) ?? "";
  try {
    const parsed: unknown = JSON.parse(last);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "wakeAgent" in parsed &&
      parsed.wakeAgent === false
    );
  } catch {
    return false;
  }
}

function outcome(result: ScriptResult) {
  const output = result.output.length > 0 ? result.output : null;
  if (result.timedOut) {
    return { status: "failed" as const, error: "Script timed out", output };
  }
  if (result.exitCode !== 0) {
    const detail = firstLine(result.stderr);
    const code = result.exitCode ?? "null";
    return {
      status: "failed" as const,
      error: `Script exited with code ${code}${detail ? `: ${detail}` : ""}`,
      output,
    };
  }
  if (output === null || output.trim() === "") {
    return { status: "skipped" as const, skipReason: "empty output" };
  }
  if (wakeAgentOff(output)) {
    return { status: "skipped" as const, skipReason: "wakeAgent false" };
  }
  return { status: "succeeded" as const, output };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function automationsServer(bb: PluginServerApi): void {
  const store = openStore(bb);

  const changed = (automation: Pick<Automation, "id" | "projectId">) => {
    bb.changed(automations.list);
    bb.changed(automations.get);
    bb.changed(automations.runs);
    bb.emit(automations.changed, {
      projectId: automation.projectId,
      automationId: automation.id,
    });
  };

  const find = (projectId: string, automationId: string): Automation => {
    const found = store.get(projectId, automationId);
    if (!found) return fail("not_found", "Automation not found");
    return found;
  };

  const checkTrigger = (trigger: Trigger) => {
    const problem = validateTrigger(trigger, bb.now());
    if (problem) fail("invalid", problem);
  };

  const schedule = (automation: Automation): Automation => ({
    ...automation,
    nextRunAt: automation.enabled
      ? nextRunAt(automation.trigger, bb.now())
      : null,
  });

  const save = (automation: Automation): Automation => {
    store.save(automation, bb.now());
    changed(automation);
    return find(automation.projectId, automation.id);
  };

  const stops = new Map<string, AbortController>();

  async function scriptDirectory(
    projectId: string,
    hostId: string,
    execution: ScriptExecution,
  ): Promise<string | null> {
    const directory = execution.workingDirectory;
    if (directory.type === "path") return directory.path;
    if (directory.type === "automation-storage") return null;
    const project = await bb.call(projects.get, { projectId });
    const source = findLocalPathProjectSourceForHost(project.sources, hostId);
    if (!source) {
      return fail(
        "unavailable",
        `Project ${projectId} has no folder on machine ${hostId}`,
      );
    }
    return source.path;
  }

  async function runScript(
    automation: Automation,
    execution: ScriptExecution,
    run: Run,
  ): Promise<void> {
    const stop = new AbortController();
    stops.set(run.id, stop);
    try {
      const hostId =
        execution.hostId ?? (await defaultHost(bb, automation.projectId));
      const result = await bb.runners.call(
        hostId,
        automations.runScript,
        {
          script: execution.script,
          interpreter: execution.interpreter ?? "bash",
          timeoutMs: execution.timeoutMs,
          env: execution.env ?? {},
          cwd: await scriptDirectory(automation.projectId, hostId, execution),
        },
        { timeoutMs: execution.timeoutMs + 30_000, signal: stop.signal },
      );
      const ended = outcome(result);
      store.finish(run.id, ended.status, ended.error ?? null, bb.now(), {
        output: ended.output ?? null,
        exitCode: result.exitCode,
        ...(ended.skipReason ? { skipReason: ended.skipReason } : {}),
      });
    } catch (error) {
      if (store.byId(automation.id)) {
        store.finish(run.id, "failed", message(error), bb.now());
      }
    } finally {
      stops.delete(run.id);
    }
    if (store.byId(automation.id)) changed(automation);
  }

  async function dispatch(automation: Automation, run: Run): Promise<void> {
    const { execution } = automation;
    if (execution.mode === "script") {
      void runScript(automation, execution, run);
      return;
    }
    const text = `[bb automation due:${automation.id}]\n\n${execution.prompt}`;
    const input = [{ type: "text" as const, text, mentions: [] }];
    try {
      if (execution.targetThreadId) {
        await bb.call(threads.send, {
          threadId: execution.targetThreadId,
          mode: "steer-if-active",
          input,
        });
        store.setThread(run.id, automation.id, execution.targetThreadId);
      } else {
        const thread = await bb.call(threads.create, {
          projectId: automation.projectId,
          origin: "plugin",
          originPluginId: bb.pluginId,
          title: automation.name,
          input,
          providerId: execution.providerId,
          model: execution.model,
          reasoningLevel: execution.reasoningLevel,
          permissionMode: execution.permissionMode,
          environment: execution.environment,
          startedOnBehalfOf: null,
          ...(execution.serviceTier
            ? { serviceTier: execution.serviceTier }
            : {}),
        });
        store.setThread(run.id, automation.id, thread.id);
      }
    } catch (error) {
      store.finish(run.id, "failed", message(error), bb.now());
      bb.log.warn("Automation run failed to start", {
        automationId: automation.id,
        error: message(error),
      });
    }
    changed(automation);
  }

  async function fire(automation: Automation): Promise<void> {
    const now = bb.now();
    const scheduledFor = automation.nextRunAt ?? now;
    const once = automation.trigger.triggerType === "once";
    store.save(
      {
        ...automation,
        enabled: !once,
        nextRunAt: once ? null : nextRunAt(automation.trigger, now),
      },
      now,
    );
    if (store.running(automation.id)) {
      store.startRun({
        automationId: automation.id,
        runMode: automation.execution.mode,
        trigger: "schedule",
        scheduledFor,
        now,
        status: "skipped",
        skipReason: "previous run is still running",
      });
      changed(automation);
      return;
    }
    const run = store.startRun({
      automationId: automation.id,
      runMode: automation.execution.mode,
      trigger: "schedule",
      scheduledFor,
      now,
    });
    await dispatch(automation, run);
  }

  async function sweep(): Promise<void> {
    for (const automation of store.due(bb.now())) {
      try {
        await fire(automation);
      } catch (error) {
        bb.log.error("Automation sweep failed", {
          automationId: automation.id,
          error: message(error),
        });
      }
    }
  }

  bb.background.service("automation-sweep", {
    async start(signal) {
      while (!signal.aborted) {
        await sweep();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SWEEP_INTERVAL_MS);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  });

  const settle = (
    threadId: string,
    status: Run["status"],
    error: string | null,
  ) => {
    for (const run of store.openRunsOf(threadId)) {
      store.finish(run.id, status, error, bb.now());
      const automation = store.byId(run.automationId);
      if (automation) changed(automation);
    }
  };
  bb.on(threads.idle, ({ thread }) => settle(thread.id, "succeeded", null));
  bb.on(threads.failed, ({ thread, error }) =>
    settle(thread.id, "failed", error ?? "Thread failed"),
  );
  bb.on(threads.deleted, ({ thread }) => {
    settle(
      thread.id,
      "skipped",
      `interrupted: thread ${thread.id} was deleted`,
    );
    for (const automation of store.targeting(thread.id)) {
      if (automation.enabled)
        save({ ...automation, enabled: false, nextRunAt: null });
    }
  });

  bb.implement(automations.list, async ({ projectId }) => {
    await bb.call(projects.get, { projectId });
    return store.list(projectId);
  });
  bb.implement(automations.get, ({ projectId, automationId }) =>
    find(projectId, automationId),
  );
  bb.implement(automations.create, async (input, { caller }) => {
    checkTrigger(input.trigger);
    const creator = input.createdByThreadId ?? caller.thread;
    if (creator) {
      const thread = await bb.call(threads.get, { threadId: creator });
      if (thread.originPluginId === bb.pluginId) {
        deny("Threads started by an automation cannot create automations.");
      }
    }
    const id = store.insert(input, bb.now());
    const created = find(input.projectId, id);
    changed(created);
    return created;
  });
  bb.implement(automations.update, (input) => {
    const current = find(input.projectId, input.automationId);
    if (input.trigger) checkTrigger(input.trigger);
    const execution = input.execution ?? current.execution;
    return save(
      schedule({
        ...current,
        name: input.name ?? current.name,
        trigger: input.trigger ?? current.trigger,
        execution,
      }),
    );
  });
  bb.implement(automations.pause, ({ projectId, automationId }) =>
    save({ ...find(projectId, automationId), enabled: false, nextRunAt: null }),
  );
  bb.implement(automations.resume, ({ projectId, automationId }) => {
    const current = find(projectId, automationId);
    if (current.trigger.triggerType === "once") checkTrigger(current.trigger);
    return save(schedule({ ...current, enabled: true }));
  });
  bb.implement(automations.delete, ({ projectId, automationId }) => {
    const current = find(projectId, automationId);
    for (const run of store.runs(current.id, RUNS_LIMIT_DEFAULT, 0).runs) {
      stops.get(run.id)?.abort();
    }
    store.remove(current.id);
    changed(current);
  });
  bb.implement(automations.run, (input) => {
    const automation = find(input.projectId, input.automationId);
    const key = input.idempotencyKey;
    const earlier = key ? store.byKey(automation.id, key) : undefined;
    if (earlier) return { run: earlier };
    const now = bb.now();
    const run = store.startRun({
      automationId: automation.id,
      runMode: automation.execution.mode,
      trigger: "manual",
      scheduledFor: now,
      now,
      ...(key ? { idempotencyKey: key } : {}),
    });
    changed(automation);
    void dispatch(automation, run);
    return { run };
  });
  bb.implement(automations.runs, (input) => {
    const automation = find(input.projectId, input.automationId);
    return store.runs(
      automation.id,
      input.limit ?? RUNS_LIMIT_DEFAULT,
      Number(input.cursor ?? 0),
    );
  });

  registerCli(bb);
}
