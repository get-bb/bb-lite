import {
  threadScope,
  WORKSPACE_PROVISIONING_STEP_KEYS,
  type PromptInput,
  type ProvisioningTranscriptEntry,
  type SystemThreadProvisioningStatus,
} from "@bb/domain";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { getEnvironmentRow } from "../db/engine-lookups.js";
import { decodeJson, newId } from "../db/index.js";
import { getThread, patchThread, type ThreadRow } from "../db/threads.js";
import {
  environmentIntentSchema,
  type ThreadEnvironment,
} from "../environments/types.js";
import { ApiError } from "../http/errors.js";
import { errorMessage, type Outbox } from "./core.js";
import {
  attributedMessage,
  consumeRows,
  submitToRunner,
  turnRequestEvent,
  type DispatchArgs,
  type OutboundMessage,
} from "./dispatch.js";
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
  message: OutboundMessage;
}

const TITLE_FALLBACK_MAX_LENGTH = 80;
const GENERATED_TITLE_MAX_LENGTH = 48;
const TITLE_MIN_WORDS = 5;
const TITLE_TIMEOUT_MS = 5_000;

type StepStatus = NonNullable<ProvisioningTranscriptEntry["status"]>;
type Recorder = (entries: ProvisioningTranscriptEntry[]) => void;

function step(
  key: string,
  text: string,
  status: StepStatus,
  startedAt: number,
  metadata?: Record<string, unknown>,
): ProvisioningTranscriptEntry {
  const entry = { type: "step" as const, key, text, status, startedAt };
  return metadata === undefined ? entry : { ...entry, metadata };
}

function promptText(input: readonly PromptInput[]): string {
  return input
    .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function deriveTitleFallback(input: readonly PromptInput[]) {
  const text = promptText(input);
  if (text === "") return null;
  if (text.length <= TITLE_FALLBACK_MAX_LENGTH) return text;
  return `${text.slice(0, TITLE_FALLBACK_MAX_LENGTH - 3)}...`;
}

function titlePrompt(input: readonly PromptInput[]): string | null {
  const text = deriveTitleFallback(input);
  const words = text?.split(" ").length ?? 0;
  return words >= TITLE_MIN_WORDS ? text : null;
}

function sanitizeTitle(generated: string | null): string | null {
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
  status: SystemThreadProvisioningStatus,
  entries: ProvisioningTranscriptEntry[],
): void {
  const { environmentId } = thread;
  const progress = { provisioningId, status, environmentId, entries };
  const type = "system/thread-provisioning";
  engine.append(out, thread, [{ type, scope: threadScope(), ...progress }]);
}

async function generateTitle(
  engine: Engine,
  threadId: string,
  job: ProvisioningJob,
  record: Recorder,
): Promise<void> {
  const { extensions, log, now } = engine.ctx;
  const startedAt = now();
  record([step("metadata-started", "Generating title", "started", startedAt)]);
  const prompt = titlePrompt(job.message.input);
  const timeout = delay(TITLE_TIMEOUT_MS, null, { ref: false });
  const generated =
    prompt === null
      ? null
      : await Promise.race([extensions.generateTitle(prompt), timeout]).catch(
          (err: unknown) => {
            log.warn("Thread title generation failed", { err, threadId });
            return null;
          },
        );
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
): Promise<void> {
  const { ctx } = engine;
  const { db } = ctx;
  const { environmentId, path } = environment;
  const thread = getThread(db, threadId);
  if (thread === undefined || thread.deletedAt !== null) return;
  const current = isCurrent(engine, thread, job);
  const row = getEnvironmentRow(db, environmentId);
  if (row === undefined) throw new Error("Prepared environment is missing");
  const attached = engine.commit((out) => {
    const next = patchThread(db, threadId, { environmentId });
    const { projectId } = thread;
    out.thread(threadId, ["environment-changed"], { projectId });
    if (!current) return next;
    const keys = WORKSPACE_PROVISIONING_STEP_KEYS;
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
  const { execution, initiator, input } = job.message;
  const host = { id: environmentId, hostId: row.hostId, path };
  const session = await buildSessionSpec(ctx, attached, host, execution.model);
  engine.commit((out) => {
    appendProvisioning(engine, out, attached, job.id, "completed", []);
    const starting = { kind: "turn-starting" as const };
    engine.relabelWaits(out, threadId, ["provisioning"], starting);
    engine.transition(out, threadId, "run.started");
    const options = toRunnerOptions(execution, initiator, input);
    const clientRequestId = job.requestId;
    const turn = { session, clientRequestId, input, options };
    out.after(() =>
      submitToRunner(engine, row.hostId, { ...turn, mode: { kind: "start" } }),
    );
  });
}

function failProvisioning(
  engine: Engine,
  threadId: string,
  job: ProvisioningJob,
  error: unknown,
): void {
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
): Promise<void> {
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

export function beginProvisioning(
  engine: Engine,
  thread: ThreadRow,
  args: DispatchArgs,
): void {
  const { db } = engine.ctx;
  if (thread.startupContext === null) {
    const message = `Thread ${thread.id} has no workspace to start in`;
    throw new ApiError(500, "internal_error", message);
  }
  const startup = decodeJson(startupContextSchema, thread.startupContext);
  const message = attributedMessage(args.message);
  const requestId = newId("creq");
  const job = { id: newId("tpv"), requestId, startup, message };
  engine.commit((out) => {
    consumeRows(engine, out, thread, args.rows);
    const target = { kind: "thread-start" as const };
    const { initiator } = message;
    const request = { method: "thread/start" as const, params: {} };
    const start = { direction: "outbound", source: "spawn" } as const;
    const type = "client/thread/start";
    engine.append(out, thread, [
      turnRequestEvent(message, requestId, target),
      { type, scope: threadScope(), ...start, initiator, request },
    ]);
    patchThread(db, thread.id, message.execution, false);
    engine.transition(out, thread.id, "run.preparing");
    const provisioned = (): Promise<void> =>
      runProvisioning(engine, thread.id, job);
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
