import * as domain from "@bb/domain";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { getEnvironment } from "@bb/server-kit/db/environments";
import { decodeJson, newId } from "@bb/server-kit/db/index";
import {
  getThread,
  patchThread,
  type ThreadRow,
} from "@bb/server-kit/db/threads";
import {
  environmentIntentSchema,
  step,
  type ThreadEnvironment,
} from "@bb/server-kit/environments/types";
import { ApiError, errorMessage } from "@bb/server-kit/http/errors";
import type { Outbox } from "./core.js";
import * as dispatching from "./dispatch.js";
import type { Engine } from "./engine.js";
import { toRunnerOptions } from "./execution.js";
import { buildSessionSpec } from "./session-spec.js";

export const startupContextSchema = z.object({
  intent: environmentIntentSchema,
  titleProvided: z.boolean(),
});
export type StartupContext = z.infer<typeof startupContextSchema>;

interface ProvisioningJob {
  id: string;
  requestId: string;
  startup: StartupContext;
  message: dispatching.OutboundMessage;
}

const TITLE_FALLBACK_MAX_LENGTH = 80;
const GENERATED_TITLE_MAX_LENGTH = 48;
const TITLE_MIN_WORDS = 5;
const TITLE_TIMEOUT_MS = 5_000;

type Recorder = (entries: domain.ProvisioningTranscriptEntry[]) => void;

function promptText(input: readonly domain.PromptInput[]) {
  return input
    .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function deriveTitleFallback(input: readonly domain.PromptInput[]) {
  const text = promptText(input);
  if (text === "") return null;
  if (text.length <= TITLE_FALLBACK_MAX_LENGTH) return text;
  return `${text.slice(0, TITLE_FALLBACK_MAX_LENGTH - 3)}...`;
}

function titlePrompt(input: readonly domain.PromptInput[]) {
  const text = deriveTitleFallback(input);
  const words = text?.split(" ").length ?? 0;
  return words >= TITLE_MIN_WORDS ? text : null;
}

function sanitizeTitle(generated: string | null) {
  const title = generated?.trim().replace(/\s+/gu, " ") ?? "";
  return title.slice(0, GENERATED_TITLE_MAX_LENGTH).trim() || null;
}

function isCurrent(engine: Engine, thread: ThreadRow, job: ProvisioningJob) {
  const running = engine.runtimeOf(thread.id).provisioning;
  return thread.status === "starting" && running?.id === job.id;
}

function appendProvisioning(
  engine: Engine,
  out: Outbox,
  thread: ThreadRow,
  provisioningId: string,
  status: domain.SystemThreadProvisioningStatus,
  entries: domain.ProvisioningTranscriptEntry[],
) {
  const { environmentId } = thread;
  const progress = { provisioningId, status, environmentId, entries };
  const type = "system/thread-provisioning";
  engine.append(out, thread, [
    { type, scope: domain.threadScope(), ...progress },
  ]);
}

async function generateTitle(
  engine: Engine,
  threadId: string,
  job: ProvisioningJob,
  record: Recorder,
) {
  const { plugins, now } = engine.ctx;
  const startedAt = now();
  record([step("metadata-started", "Generating title", "started", startedAt)]);
  const prompt = titlePrompt(job.message.input);
  const signal = AbortSignal.timeout(TITLE_TIMEOUT_MS);
  const timeout = delay(TITLE_TIMEOUT_MS, null, { ref: false });
  const generated =
    prompt === null
      ? null
      : await Promise.race([plugins.generateTitle(prompt, signal), timeout]);
  const title = sanitizeTitle(generated);
  const titleGenerated = title !== null;
  const text = titleGenerated ? "Generated title" : "No title generated";
  const metadata = { durationMs: now() - startedAt, titleGenerated };
  record([step("metadata-completed", text, "completed", startedAt, metadata)]);
  if (title === null) return;
  await engine.inThread(threadId, () => engine.adoptTitle(threadId, title));
}

async function completeProvisioning(
  engine: Engine,
  threadId: string,
  job: ProvisioningJob,
  environment: ThreadEnvironment,
) {
  const { ctx } = engine;
  const { db } = ctx;
  const { environmentId, path } = environment;
  const thread = getThread(db, threadId);
  if (thread === undefined || thread.deletedAt !== null) return;
  const current = isCurrent(engine, thread, job);
  const row = getEnvironment(db, environmentId);
  if (row === undefined) throw new Error("Prepared environment is missing");
  const attached = engine.commit((out) => {
    const next = patchThread(db, threadId, { environmentId });
    const { projectId } = thread;
    out.thread(threadId, ["environment-changed"], { projectId });
    if (!current) return next;
    const keys = domain.WORKSPACE_PROVISIONING_STEP_KEYS;
    const { branchName } = row;
    const at = ctx.now();
    const workspace = `Using workspace: ${path}`;
    const entries = [step(keys.workspacePath, workspace, "completed", at)];
    if (branchName !== null) {
      const text = `Using branch: ${branchName}`;
      const key = keys.workspaceBranch;
      entries.push(step(key, text, "completed", at, { branchName }));
    }
    appendProvisioning(engine, out, next, job.id, "active", entries);
    return next;
  });
  if (!current) return;
  const { input } = job.message;
  const host = { id: environmentId, hostId: row.hostId, path };
  const session = await buildSessionSpec(ctx, attached, host);
  engine.commit((out) => {
    appendProvisioning(engine, out, attached, job.id, "completed", []);
    const starting = { kind: "turn-starting" as const };
    engine.relabelWaits(out, threadId, ["provisioning"], starting);
    engine.transition(out, threadId, "run.started");
    const options = toRunnerOptions(db, attached.providerId, job.message);
    const clientRequestId = job.requestId;
    const mode = { kind: "start" as const };
    const turn = { session, clientRequestId, input, options, mode };
    out.after(() =>
      dispatching.submitToRunner(engine, attached, row.hostId, turn),
    );
  });
}

function failProvisioning(
  engine: Engine,
  threadId: string,
  job: ProvisioningJob,
  error: unknown,
) {
  const { db, log, now } = engine.ctx;
  const thread = getThread(db, threadId);
  if (thread === undefined || !isCurrent(engine, thread, job)) return;
  log.warn("Thread provisioning failed", { err: error, threadId });
  engine.commit((out) => {
    if (thread.environmentId === null) {
      const text = "Workspace setup failed";
      const entries = [step("workspace-failed", text, "failed", now())];
      appendProvisioning(engine, out, thread, job.id, "failed", entries);
    }
    engine.relabelWaits(out, threadId, ["provisioning"], null);
    const code = "thread_provisioning_failed";
    const message = "Provisioning thread failed";
    const failure = { code, message, detail: errorMessage(error) };
    const context = "failed during workspace setup before a turn began";
    engine.failThread(out, thread, failure, context);
  });
}

async function runProvisioning(
  engine: Engine,
  threadId: string,
  job: ProvisioningJob,
) {
  const { db, environments, now } = engine.ctx;
  const runtime = engine.runtimeOf(threadId);
  const abort = new AbortController();
  runtime.provisioning = { id: job.id, abort };
  const record: Recorder = (entries) =>
    engine.later(threadId, "provisioning progress", () => {
      const thread = getThread(db, threadId);
      if (thread === undefined || !isCurrent(engine, thread, job)) return;
      engine.commit((out) =>
        appendProvisioning(engine, out, thread, job.id, "active", entries),
      );
    });
  const { intent, titleProvided } = job.startup;
  try {
    const preparing = "Preparing workspace";
    record([step("workspace-started", preparing, "started", now())]);
    const builds = intent.type !== "reuse";
    const titled = titleProvided
      ? Promise.resolve()
      : generateTitle(engine, threadId, job, builds ? record : () => {});
    if (builds) await titled;
    else engine.background("generate title", titled);
    const thread = getThread(db, threadId);
    if (thread === undefined) return;
    const { signal } = abort;
    const onProgress = record;
    const request = { thread, intent, signal, onProgress };
    const environment = await environments.ensureForThread(request);
    await engine.inThread(threadId, () =>
      completeProvisioning(engine, threadId, job, environment),
    );
  } catch (error) {
    await engine.inThread(threadId, () =>
      failProvisioning(engine, threadId, job, error),
    );
  } finally {
    if (runtime.provisioning?.id === job.id) runtime.provisioning = null;
  }
}

function startupOf(thread: ThreadRow): StartupContext {
  const { environmentId, startupContext } = thread;
  if (environmentId !== null) {
    const intent = { type: "reuse" as const, environmentId };
    return { intent, titleProvided: true };
  }
  if (startupContext !== null) {
    return decodeJson(startupContextSchema, startupContext);
  }
  const message = `Thread ${thread.id} has no workspace to start in`;
  throw new ApiError(500, "internal_error", message);
}

export function beginProvisioning(
  engine: Engine,
  thread: ThreadRow,
  args: dispatching.DispatchArgs,
): void {
  const { db } = engine.ctx;
  const startup = startupOf(thread);
  const message = dispatching.attributedMessage(args.message);
  const requestId = newId("creq");
  const job = { id: newId("tpv"), requestId, startup, message };
  engine.commit((out) => {
    dispatching.consumeRows(engine, out, thread, args.rows);
    const restores = thread.environmentId !== null;
    const kind = restores ? "new-turn" : "thread-start";
    const { initiator } = message;
    const request = { method: "thread/start" as const, params: {} };
    const start = { direction: "outbound", source: "spawn" } as const;
    const type = "client/thread/start";
    const started = { type, scope: domain.threadScope(), ...start } as const;
    engine.append(out, thread, [
      dispatching.turnRequestEvent(message, requestId, { kind }),
      ...(restores ? [] : [{ ...started, initiator, request }]),
    ]);
    patchThread(db, thread.id, message.execution, false);
    engine.transition(out, thread.id, "run.preparing");
    const provisioned = () => runProvisioning(engine, thread.id, job);
    out.after(() => engine.background("provisioning", provisioned()));
  });
}

export function cancelProvisioning(
  engine: Engine,
  out: Outbox,
  thread: ThreadRow,
): void {
  const runtime = engine.runtimeOf(thread.id);
  const running = runtime.provisioning;
  if (running === null) return;
  runtime.provisioning = null;
  running.abort.abort();
  const text = "Provisioning stopped by user request";
  const at = engine.ctx.now();
  const stopped = [step("provisioning-stopped", text, "completed", at)];
  appendProvisioning(engine, out, thread, running.id, "cancelled", stopped);
  engine.relabelWaits(out, thread.id, ["provisioning"], null);
}
