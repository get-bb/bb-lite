import {
  threadScope,
  WORKSPACE_PROVISIONING_STEP_KEYS,
  type PromptInput,
  type ProvisioningTranscriptEntry,
  type SystemThreadProvisioningStatus,
} from "@bb/domain";
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
  const invokesCommand = input.some(
    (part) =>
      part.type === "text" &&
      part.mentions.some((mention) => mention.resource.kind === "command"),
  );
  const words = text?.split(" ").length ?? 0;
  return invokesCommand || words >= TITLE_MIN_WORDS ? text : null;
}

function sanitizeTitle(generated: string | null): string | null {
  const title = generated?.trim().replace(/\s+/gu, " ") ?? "";
  if (title.length <= GENERATED_TITLE_MAX_LENGTH) return title || null;
  const clipped = title.slice(0, GENERATED_TITLE_MAX_LENGTH + 1);
  const boundary = clipped.lastIndexOf(" ");
  return clipped.slice(0, boundary > 0 ? boundary : GENERATED_TITLE_MAX_LENGTH);
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

function recordProgress(
  engine: Engine,
  threadId: string,
  job: ProvisioningJob,
  entries: ProvisioningTranscriptEntry[],
): void {
  const thread = getThread(engine.ctx.db, threadId);
  if (thread === undefined || !isCurrent(engine, thread, job)) return;
  engine.commit((out) =>
    appendProvisioning(engine, out, thread, job.id, "active", entries),
  );
}

async function generateTitle(
  engine: Engine,
  threadId: string,
  job: ProvisioningJob,
  writesTranscript: boolean,
): Promise<void> {
  const { extensions, log, now } = engine.ctx;
  const startedAt = now();
  const step = { type: "step" as const, startedAt };
  const record = (entry: ProvisioningTranscriptEntry) =>
    writesTranscript
      ? engine.inThread(threadId, () =>
          recordProgress(engine, threadId, job, [entry]),
        )
      : Promise.resolve();
  const started = { key: "metadata-started", text: "Generating title" };
  await record({ ...step, ...started, status: "started" });
  const prompt = titlePrompt(job.message.input);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), TITLE_TIMEOUT_MS);
  });
  const generated =
    prompt === null
      ? null
      : await Promise.race([extensions.generateTitle(prompt), timeout]).catch(
          (error: unknown) => {
            log.warn("Thread title generation failed", {
              err: error,
              threadId,
            });
            return null;
          },
        );
  clearTimeout(timer);
  const title = sanitizeTitle(generated);
  const titleGenerated = title !== null;
  await record({
    ...step,
    key: "metadata-completed",
    text: titleGenerated ? "Generated title" : "No title generated",
    status: "completed",
    metadata: { durationMs: now() - startedAt, titleGenerated },
  });
  if (title !== null) {
    await engine.inThread(threadId, () => engine.adoptTitle(threadId, title));
  }
}

function workspaceEntries(
  path: string,
  branchName: string | null,
  startedAt: number,
): ProvisioningTranscriptEntry[] {
  const step = { type: "step" as const, status: "completed" as const };
  const keys = WORKSPACE_PROVISIONING_STEP_KEYS;
  const workspace = {
    key: keys.workspacePath,
    text: `Using workspace: ${path}`,
  };
  const entries = [{ ...step, ...workspace, startedAt }];
  if (branchName === null) return entries;
  const text = `Using branch: ${branchName}`;
  const branch = { key: keys.workspaceBranch, text, startedAt };
  return [...entries, { ...step, ...branch, metadata: { branchName } }];
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
    const next = patchThread(db, threadId, { environmentId }) ?? thread;
    const { projectId } = thread;
    out.thread(threadId, ["environment-changed"], { projectId });
    if (!current) return next;
    const entries = workspaceEntries(path, row.branchName, ctx.now());
    appendProvisioning(engine, out, next, job.id, "active", entries);
    return next;
  });
  if (!current) return;
  const { execution, initiator, input } = job.message;
  const host = { id: environmentId, hostId: row.hostId, path };
  const session = await buildSessionSpec(ctx, attached, host, execution.model);
  engine.commit((out) => {
    appendProvisioning(engine, out, attached, job.id, "completed", []);
    engine.relabelWaits(out, threadId, ["provisioning"], {
      kind: "turn-starting",
    });
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
      const step = { type: "step" as const, key: "workspace-failed" };
      const text = "Workspace setup failed";
      const failed = { ...step, text, status: "failed" as const };
      const entries = [{ ...failed, startedAt: now() }];
      appendProvisioning(engine, out, thread, job.id, "failed", entries);
    }
    engine.relabelWaits(out, threadId, ["provisioning"], null);
    engine.failThread(
      out,
      thread,
      {
        code: "thread_provisioning_failed",
        message: "Provisioning thread failed",
        detail: errorMessage(error),
      },
      "failed during workspace setup before a turn began",
    );
  });
}

async function runProvisioning(
  engine: Engine,
  threadId: string,
  job: ProvisioningJob,
): Promise<void> {
  const { db, environments } = engine.ctx;
  const runtime = engine.runtimeOf(threadId);
  const abort = new AbortController();
  runtime.provisioning = { id: job.id, abort };
  const record = (entries: ProvisioningTranscriptEntry[]): void =>
    engine.later(threadId, "provisioning progress", () =>
      recordProgress(engine, threadId, job, entries),
    );
  const { intent, titleProvided } = job.startup;
  try {
    const step = { type: "step" as const, key: "workspace-started" };
    record([{ ...step, text: "Preparing workspace", status: "started" }]);
    const buildsWorkspace = intent.type !== "reuse";
    const titled = titleProvided
      ? Promise.resolve()
      : generateTitle(engine, threadId, job, buildsWorkspace);
    if (buildsWorkspace) await titled;
    else engine.background("generate title", titled);
    const thread = getThread(db, threadId);
    if (thread === undefined) return;
    const { signal } = abort;
    const environment = await environments.ensureForThread({
      thread,
      intent,
      signal,
      onProgress: record,
    });
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
    engine.append(out, thread, [
      turnRequestEvent(message, requestId, target),
      {
        type: "client/thread/start",
        scope: threadScope(),
        direction: "outbound",
        source: "spawn",
        initiator,
        request: { method: "thread/start", params: {} },
      },
    ]);
    patchThread(db, thread.id, message.execution, false);
    engine.transition(out, thread.id, "run.preparing");
    out.after(() =>
      engine.background(
        "provisioning",
        runProvisioning(engine, thread.id, job),
      ),
    );
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
  const step = { type: "step" as const, key: "provisioning-stopped" };
  const text = "Provisioning stopped by user request";
  const startedAt = engine.ctx.now();
  const stopped = { ...step, text, status: "completed" as const, startedAt };
  appendProvisioning(engine, out, thread, running.id, "cancelled", [stopped]);
  engine.relabelWaits(out, thread.id, ["provisioning"], null);
}
