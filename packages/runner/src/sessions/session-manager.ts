import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import {
  threadScope,
  turnScope,
  type PendingInteractionResolution,
  type ToolCallResponse,
} from "@bb/domain";
import { EventBuilder } from "../events/event-builder.js";
import type {
  ProviderAdapter,
  ProviderSession,
  SessionHost,
} from "../providers/provider.js";
import {
  RunnerError,
  type ExecutionOptions,
  type ProviderId,
  type RunnerThreadEvent,
  type SessionApi,
  type SubmitTurnArgs,
  type SubmitTurnResult,
} from "../types.js";
import { buildAgentEnv, loginShellPath } from "./agent-env.js";
import type { Outbox } from "./outbox.js";

export interface SessionTiming {
  turnStartTimeoutMs: number;
  watchdogIntervalMs: number;
  interruptTimeoutMs: number;
  idleReapMs: number;
}

export interface SessionApiOptions {
  dataDir: string;
  serverUrl: string;
  bbCliPath: string;
  outbox: Outbox;
  adapters: ProviderAdapter[];
  version?: string;
  terminalIds?: () => string[];
  loginPath?: () => Promise<string | null>;
  timing?: Partial<SessionTiming>;
}

export type ManagedSessionApi = SessionApi & { shutdown(): Promise<void> };

interface Pending<T> {
  turnId: string | null;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface LiveSession {
  threadId: string;
  adapter: ProviderAdapter;
  provider: ProviderSession;
  events: EventBuilder;
  options: ExecutionOptions;
  envKey: string;
  pendingStart: { since: number; warned: boolean } | null;
  lastActiveAt: number;
  closed: boolean;
  interactions: Map<string, Pending<PendingInteractionResolution>>;
  toolCalls: Map<string, Pending<ToolCallResponse>>;
}

const DEFAULT_TIMING: SessionTiming = {
  turnStartTimeoutMs: 120_000,
  watchdogIntervalMs: 15_000,
  interruptTimeoutMs: 5_000,
  idleReapMs: 30 * 60_000,
};
const THREAD_ID = /^[A-Za-z0-9_-]+$/;
const MAX_REMEMBERED_REQUESTS = 32;
const POLL_MS = 20;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, deadline: number) {
  while (!condition() && Date.now() < deadline) await sleep(POLL_MS);
  return condition();
}

function toRunnerError(error: unknown) {
  if (error instanceof RunnerError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RunnerError("failed", message);
}

export function createSessionApi(
  options: SessionApiOptions,
): ManagedSessionApi {
  const timing = { ...DEFAULT_TIMING, ...options.timing };
  const { outbox } = options;
  const instanceId = randomUUID();
  const storageRoot = join(options.dataDir, "thread-storage");
  const adapters = new Map(options.adapters.map((a) => [a.id, a]));
  const sessions = new Map<string, LiveSession>();
  const chains = new Map<string, Promise<unknown>>();
  const remembered = new Map<string, Map<string, Promise<SubmitTurnResult>>>();
  const resolveLoginPath = options.loginPath ?? loginShellPath;
  let requestCounter = 0;

  function adapterFor(providerId: ProviderId) {
    const adapter = adapters.get(providerId);
    if (adapter !== undefined) return adapter;
    const message = `Provider "${providerId}" is not available on this runner`;
    throw new RunnerError("unavailable", message);
  }

  function serialize<T>(threadId: string, task: () => Promise<T>) {
    const run = (chains.get(threadId) ?? Promise.resolve()).then(task, task);
    const tail = run.catch(() => undefined);
    chains.set(threadId, tail);
    void tail.then(() => {
      if (chains.get(threadId) === tail) chains.delete(threadId);
    });
    return run;
  }

  function isBusy(live: LiveSession) {
    return live.events.activeTurnId !== null || live.pendingStart !== null;
  }

  function cancelRequests(live: LiveSession, reason: string, turnId?: string) {
    const { threadId } = live;
    const matches = (pending: Pending<unknown>) =>
      turnId === undefined || pending.turnId === turnId;
    for (const [requestId, pending] of [...live.interactions]) {
      if (!matches(pending)) continue;
      live.interactions.delete(requestId);
      const kind = "interaction.cancelled";
      outbox.emit({ kind, threadId, requestId, reason });
      pending.reject(new Error(`Interaction cancelled: ${reason}`));
    }
    for (const [requestId, pending] of [...live.toolCalls]) {
      if (!matches(pending)) continue;
      live.toolCalls.delete(requestId);
      outbox.emit({ kind: "toolCall.cancelled", threadId, requestId });
      pending.reject(new Error(`Tool call cancelled: ${reason}`));
    }
  }

  function onEvent(live: LiveSession, event: RunnerThreadEvent) {
    live.lastActiveAt = Date.now();
    outbox.threadEvent(live.threadId, event);
    if (event.scope.kind !== "turn") return;
    if (event.type === "turn/completed") {
      cancelRequests(live, "turn_completed", event.scope.turnId);
    } else if (event.type === "turn/started" && !event.parentToolCallId) {
      live.pendingStart = null;
    }
  }

  function systemError(
    live: LiveSession,
    turnId: string | null,
    code: string,
    message: string,
    detail?: string,
  ) {
    live.events.flush();
    const scope = turnId === null ? threadScope() : turnScope(turnId);
    const error = { type: "system/error" as const, scope, code, message };
    const event = detail === undefined ? error : { ...error, detail };
    outbox.threadEvent(live.threadId, event);
  }

  function onProviderExit(
    live: LiveSession,
    info: { message: string; stderrTail: string },
  ) {
    if (live.closed) return;
    const turnId = live.events.activeTurnId;
    const wasBusy = isBusy(live);
    const message = `Provider "${live.adapter.id}" exited unexpectedly: ${info.message}`;
    live.events.settle("failed", message);
    const stderr = info.stderrTail.slice(-4000);
    const detail = stderr ? `stderr:\n${stderr}` : undefined;
    const code = "provider_process_exited";
    if (wasBusy) systemError(live, turnId, code, message, detail);
    void closeSession(live, "provider_exited");
  }

  async function closeSession(live: LiveSession, reason: string) {
    if (live.closed) return;
    live.closed = true;
    live.events.flush();
    if (sessions.get(live.threadId) === live) sessions.delete(live.threadId);
    cancelRequests(live, reason);
    await live.provider.close().catch(() => undefined);
  }

  function request<T>(
    live: LiveSession | null,
    registry: (live: LiveSession) => Map<string, Pending<T>>,
    turnId: string | null,
    announce: (live: LiveSession, requestId: string) => void,
  ) {
    if (live === null || live.closed) {
      return Promise.reject(new Error("Provider session is not open"));
    }
    requestCounter += 1;
    const requestId = `${instanceId}:${requestCounter}`;
    live.events.flush();
    return new Promise<T>((resolve, reject) => {
      registry(live).set(requestId, { turnId, resolve, reject });
      announce(live, requestId);
    });
  }

  function deliver<T>(
    registry: Map<string, Pending<T>> | undefined,
    requestId: string,
    value: T,
  ) {
    const pending = registry?.get(requestId);
    if (registry === undefined || pending === undefined) {
      return { delivered: false };
    }
    registry.delete(requestId);
    pending.resolve(value);
    return { delivered: true };
  }

  async function openSession(args: SubmitTurnArgs, previous?: LiveSession) {
    const { session: spec, options: execution } = args;
    const { threadId } = spec;
    const adapter = adapterFor(spec.providerId);
    const threadStorageDir = join(storageRoot, threadId);
    await mkdir(threadStorageDir, { recursive: true });
    const env = buildAgentEnv({
      loginPath: await resolveLoginPath(),
      bbCliPath: options.bbCliPath,
      serverUrl: options.serverUrl,
      threadStorageDir,
      specEnv: spec.env,
    });
    const envKey = JSON.stringify(env.agent);
    if (previous !== undefined) {
      const reusable =
        previous.adapter === adapter &&
        previous.envKey === envKey &&
        previous.provider.canApply(spec, execution);
      if (reusable) return Object.assign(previous, { options: execution });
      await closeSession(previous, "session_rebuilt");
    }
    let live: LiveSession | null = null;
    const events = new EventBuilder({
      providerId: adapter.id,
      emit: (event) => {
        if (live === null) outbox.threadEvent(threadId, event);
        else if (!live.closed) onEvent(live, event);
      },
    });
    const host: SessionHost = {
      events,
      env: env.agent,
      processEnv: env.process,
      threadStorageDir,
      writableRoots: [storageRoot],
      onExit: (info) => live && onProviderExit(live, info),
      requestInteraction: ({ payload, turnId }) => {
        const denies =
          adapter.approvalEnforcedBy === "runner" &&
          payload.kind === "approval" &&
          live?.options.permissionEscalation === "deny";
        if (denies) return Promise.resolve({ decision: "deny" });
        const registry = (l: LiveSession) => l.interactions;
        return request(live, registry, turnId, (l, requestId) => {
          const providerThreadId = l.provider.providerThreadId;
          const kind = "interaction.requested";
          const ids = { threadId, turnId, requestId, providerThreadId };
          outbox.emit({ kind, ...ids, providerId: adapter.id, payload });
        });
      },
      callTool: ({ callId, tool, arguments: input, turnId }) => {
        const registry = (l: LiveSession) => l.toolCalls;
        return request(live, registry, turnId, (_, requestId) => {
          const ids = { threadId, turnId, requestId, callId };
          const kind = "toolCall.requested";
          outbox.emit({ kind, ...ids, tool, arguments: input });
        });
      },
    };
    const providerThreadId =
      spec.providerThreadId ?? previous?.provider.providerThreadId ?? null;
    const resumable = { ...spec, providerThreadId };
    const provider = await adapter.open(resumable, execution, host);
    live = {
      threadId,
      adapter,
      provider,
      events,
      options: execution,
      envKey,
      pendingStart: null,
      lastActiveAt: Date.now(),
      closed: false,
      interactions: new Map(),
      toolCalls: new Map(),
    };
    sessions.set(threadId, live);
    events.flush();
    outbox.threadEvent(threadId, {
      type: "provider.env-resolved",
      providerThreadId: provider.providerThreadId,
      entries: env.entries,
      scope: threadScope(),
    });
    return live;
  }

  async function startTurn(args: SubmitTurnArgs): Promise<SubmitTurnResult> {
    const live = await openSession(args, sessions.get(args.session.threadId));
    live.pendingStart = { since: Date.now(), warned: false };
    live.lastActiveAt = Date.now();
    try {
      await live.provider.startTurn(args);
    } catch (error) {
      live.pendingStart = null;
      throw error;
    }
    const { providerThreadId } = live.provider;
    return { outcome: "started", providerThreadId };
  }

  async function submit(args: SubmitTurnArgs): Promise<SubmitTurnResult> {
    const { mode } = args;
    const live = sessions.get(args.session.threadId);
    if (mode.kind === "start") {
      if (live === undefined || !isBusy(live)) return startTurn(args);
      throw new RunnerError("competing_turn", "A turn is already running");
    }
    if (live !== undefined && mode.kind === "auto" && live.pendingStart) {
      const deadline = Date.now() + timing.interruptTimeoutMs;
      await waitFor(() => !live.pendingStart || live.closed, deadline);
    }
    const activeTurnId = live?.closed ? null : live?.events.activeTurnId;
    const expectedTurnId =
      mode.kind === "steer" ? mode.expectedTurnId : activeTurnId;
    if (live && expectedTurnId && activeTurnId === expectedTurnId) {
      const outcome = await live.provider.steer({ ...args, expectedTurnId });
      const { providerThreadId } = live.provider;
      const steered = { outcome, providerThreadId, turnId: expectedTurnId };
      if (steered.outcome === "steered")
        return { ...steered, outcome: "steered" };
    }
    if (mode.kind === "steer") {
      throw new RunnerError(
        "stale_turn",
        "The expected turn is no longer active",
      );
    }
    if (live !== undefined && !live.closed && isBusy(live)) {
      throw new RunnerError("competing_turn", "A turn is already starting");
    }
    return startTurn(args);
  }

  function remember(args: SubmitTurnArgs) {
    const { threadId } = args.session;
    const byRequest: Map<string, Promise<SubmitTurnResult>> = remembered.get(
      threadId,
    ) ?? new Map();
    remembered.set(threadId, byRequest);
    const known = byRequest.get(args.clientRequestId);
    if (known !== undefined) return known;
    const result = serialize(threadId, () => submit(args)).catch((error) => {
      byRequest.delete(args.clientRequestId);
      throw toRunnerError(error);
    });
    byRequest.set(args.clientRequestId, result);
    const oldest = byRequest.keys().next().value;
    if (byRequest.size > MAX_REMEMBERED_REQUESTS && oldest !== undefined) {
      byRequest.delete(oldest);
    }
    return result;
  }

  async function interrupt(threadId: string) {
    const live = sessions.get(threadId);
    if (live === undefined || !isBusy(live)) return { interrupted: false };
    const deadline = Date.now() + timing.interruptTimeoutMs;
    const settled = () => live.closed || !isBusy(live);
    void live.provider.interrupt().catch(() => undefined);
    if (!(await waitFor(settled, deadline))) live.events.settle("interrupted");
    await closeSession(live, "interrupted");
    return { interrupted: true };
  }

  function watch() {
    const now = Date.now();
    for (const live of [...sessions.values()]) {
      const start = live.pendingStart;
      const limitMs = timing.turnStartTimeoutMs;
      const seconds = Math.round(limitMs / 1000);
      if (start && !start.warned && now - start.since >= limitMs) {
        start.warned = true;
        const message = `The provider accepted a turn but did not start it within ${seconds}s. The request may be stalled; stopping the thread interrupts it.`;
        systemError(live, null, "provider_turn_start_timeout", message);
      }
      const idle =
        !isBusy(live) &&
        !live.events.hasOpenBackgroundWork() &&
        live.interactions.size + live.toolCalls.size === 0 &&
        now - live.lastActiveAt >= timing.idleReapMs;
      const reap = async () => {
        if (!isBusy(live)) await closeSession(live, "idle");
      };
      if (idle) void serialize(live.threadId, reap);
    }
  }

  const watchdog = setInterval(watch, timing.watchdogIntervalMs).unref();

  return {
    describe: async () => ({
      instanceId,
      version: options.version ?? "0.0.1",
      hostName: hostname(),
      platform: process.platform === "darwin" ? "darwin" : "linux",
      homeDir: homedir(),
      dataDir: options.dataDir,
      threadStorageRoot: storageRoot,
    }),
    snapshot: async () => {
      outbox.flush();
      const live = [...sessions.values()];
      return {
        sessions: live.map((session) => ({
          threadId: session.threadId,
          providerId: session.adapter.id,
          providerThreadId: session.provider.providerThreadId,
          activeTurnId: session.events.activeTurnId,
        })),
        pendingRequestIds: live.flatMap((session) => [
          ...session.interactions.keys(),
          ...session.toolCalls.keys(),
        ]),
        terminalIds: options.terminalIds?.() ?? [],
        lastEventSeq: outbox.lastSeq,
      };
    },
    ackEvents: async ({ seq }) => outbox.ack(seq),
    listProviders: () =>
      Promise.all(options.adapters.map((adapter) => adapter.status())),
    listModels: async ({ providerId, cwd }) =>
      adapterFor(providerId).listModels(cwd),
    submitTurn: (args) => remember(args),
    interruptTurn: ({ threadId }) =>
      serialize(threadId, () => interrupt(threadId)),
    releaseSession: ({ threadId }) =>
      serialize(threadId, async () => {
        const live = sessions.get(threadId);
        if (live && !isBusy(live)) await closeSession(live, "released");
      }),
    resolveInteraction: async ({ threadId, requestId, resolution }) =>
      deliver(sessions.get(threadId)?.interactions, requestId, resolution),
    resolveToolCall: async ({ threadId, requestId, result }) =>
      deliver(sessions.get(threadId)?.toolCalls, requestId, result),
    renameSession: async ({ threadId, title }) => {
      await sessions.get(threadId)?.provider.rename?.(title);
    },
    deleteThreadStorage: ({ threadId }) =>
      serialize(threadId, async () => {
        if (!THREAD_ID.test(threadId)) {
          throw new RunnerError("invalid_path", "Invalid thread id");
        }
        await interrupt(threadId);
        const live = sessions.get(threadId);
        if (live !== undefined) await closeSession(live, "deleted");
        remembered.delete(threadId);
        await rm(join(storageRoot, threadId), { recursive: true, force: true });
      }),
    shutdown: async () => {
      clearInterval(watchdog);
      const closing = [...sessions.values()].map((live) =>
        closeSession(live, "shutdown"),
      );
      await Promise.all(closing);
      outbox.flush();
    },
  };
}
