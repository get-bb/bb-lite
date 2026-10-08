import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import {
  pendingInteractionResolutionSchema,
  threadScope,
  toolCallResponseSchema,
  turnScope,
} from "@bb/domain";
import { EventBuilder } from "../events/event-builder.js";
import type {
  ProviderAdapter,
  ProviderSession,
  SessionHost,
} from "../providers/provider.js";
import {
  RunnerError,
  SERVER_URL_PLACEHOLDER,
  type ExecutionOptions,
  type ProviderId,
  type RunnerThreadEvent,
  type SessionApi,
  type SubmitTurnArgs,
  type SubmitTurnResult,
} from "../types.js";
import { createKeyedLock } from "../workspace/exec.js";
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
  adapters: ProviderAdapter[] | (() => ProviderAdapter[]);
  terminalIds?: () => string[];
  loginPath?: () => Promise<string | null>;
  timing?: Partial<SessionTiming>;
}

export type ManagedSessionApi = Omit<SessionApi, "loadPlugins" | "callOp"> & {
  shutdown(): Promise<void>;
};

interface PendingRequest {
  kind: "interaction" | "toolCall";
  turnId: string | null;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

type ExitInfo = Parameters<SessionHost["onExit"]>[0];

interface LiveSession {
  threadId: string;
  adapter: ProviderAdapter;
  provider: ProviderSession;
  events: EventBuilder;
  options: ExecutionOptions;
  envKey: string;
  pendingStart: { since: number; warned: boolean } | null;
  lastActiveAt: number;
  closing: boolean;
  detached: boolean;
  requests: Map<string, PendingRequest>;
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

async function waitFor(condition: () => boolean, deadline: number) {
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
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
  const { adapters: given } = options;
  const listAdapters = typeof given === "function" ? given : () => given;
  const sessions = new Map<string, LiveSession>();
  const serialize = createKeyedLock();
  const remembered = new Map<string, Map<string, Promise<SubmitTurnResult>>>();
  const resolveLoginPath = options.loginPath ?? loginShellPath;
  let requestCounter = 0;

  function adapterFor(providerId: ProviderId) {
    const adapter = listAdapters().find(({ id }) => id === providerId);
    if (adapter !== undefined) return adapter;
    const message = `Provider "${providerId}" is not available on this runner`;
    throw new RunnerError("unavailable", message);
  }

  function isBusy(live: LiveSession) {
    return live.events.activeTurnId !== null || live.pendingStart !== null;
  }

  function cancelRequests(live: LiveSession, reason: string, turnId?: string) {
    const { threadId } = live;
    for (const [requestId, pending] of live.requests) {
      if (turnId !== undefined && pending.turnId !== turnId) continue;
      live.requests.delete(requestId);
      if (pending.kind === "toolCall") {
        outbox.emit({ kind: "toolCall.cancelled", threadId, requestId });
      } else {
        const kind = "interaction.cancelled";
        outbox.emit({ kind, threadId, requestId, reason });
      }
      pending.reject(new Error(`Request cancelled: ${reason}`));
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
    report: { code: string; message: string; detail?: string },
  ) {
    live.events.flush();
    const scope = turnId === null ? threadScope() : turnScope(turnId);
    const event = { type: "system/error" as const, scope, ...report };
    outbox.threadEvent(live.threadId, event);
  }

  function onProviderExit(live: LiveSession, info: ExitInfo) {
    if (live.closing) return;
    const turnId = live.events.activeTurnId;
    const wasBusy = isBusy(live);
    const name = live.adapter.id;
    const message = `Provider "${name}" exited unexpectedly: ${info.message}`;
    live.events.settle("failed", message);
    const stderr = info.stderrTail.slice(-4000);
    const detail = stderr ? { detail: `stderr:\n${stderr}` } : {};
    const report = { code: "provider_process_exited", message, ...detail };
    if (wasBusy) systemError(live, turnId, report);
    void closeSession(live, "provider_exited");
  }

  async function closeSession(live: LiveSession, reason: string) {
    if (live.closing) return;
    live.closing = true;
    if (sessions.get(live.threadId) === live) sessions.delete(live.threadId);
    await live.provider.close().catch(() => undefined);
    live.events.flush();
    live.detached = true;
    cancelRequests(live, reason);
  }

  function request(
    live: LiveSession | null,
    kind: PendingRequest["kind"],
    turnId: string | null,
    announce: (live: LiveSession, requestId: string) => void,
  ) {
    if (live === null || live.closing) {
      return Promise.reject(new Error("Provider session is not open"));
    }
    requestCounter += 1;
    const requestId = `${instanceId}:${requestCounter}`;
    live.events.flush();
    return new Promise<unknown>((resolve, reject) => {
      live.requests.set(requestId, { kind, turnId, resolve, reject });
      announce(live, requestId);
    });
  }

  function deliver(threadId: string, requestId: string, value: unknown) {
    const requests = sessions.get(threadId)?.requests;
    const pending = requests?.get(requestId);
    requests?.delete(requestId);
    pending?.resolve(value);
    return { delivered: pending !== undefined };
  }

  async function openSession(args: SubmitTurnArgs, previous?: LiveSession) {
    const { session: spec, options: execution } = args;
    const { threadId } = spec;
    const adapter = adapterFor(spec.providerId);
    const threadStorageDir = join(storageRoot, threadId);
    await mkdir(threadStorageDir, { recursive: true });
    const loginPath = await resolveLoginPath();
    const { bbCliPath, serverUrl } = options;
    const paths = { loginPath, bbCliPath, serverUrl, threadStorageDir };
    const env = buildAgentEnv({ ...paths, specEnv: spec.env });
    const envKey = JSON.stringify(env.agent);
    if (previous !== undefined) {
      const sameSetup =
        previous.adapter === adapter && previous.envKey === envKey;
      const reusable = sameSetup && previous.provider.canApply(spec, execution);
      if (reusable) return Object.assign(previous, { options: execution });
      await closeSession(previous, "session_rebuilt");
    }
    let live: LiveSession | null = null;
    const emit = (event: RunnerThreadEvent) => {
      if (live === null) outbox.threadEvent(threadId, event);
      else if (!live.detached) onEvent(live, event);
    };
    const events = new EventBuilder({ emit });
    const host: SessionHost = {
      events,
      env: env.agent,
      processEnv: env.process,
      threadStorageDir,
      writableRoots: [storageRoot],
      onExit: (info) => live && onProviderExit(live, info),
      requestInteraction: async ({ payload, turnId }) => {
        const unattended = live?.options.permissionEscalation === "deny";
        const enforced = adapter.approvalEnforcedBy === "runner";
        const denied = unattended && enforced && payload.kind === "approval";
        if (denied) return { decision: "deny" };
        const providerId = adapter.id;
        const announce = (session: LiveSession, requestId: string) => {
          const ids = { threadId, turnId, requestId, providerId };
          const { providerThreadId } = session.provider;
          const kind = "interaction.requested";
          outbox.emit({ kind, ...ids, providerThreadId, payload });
        };
        const answer = await request(live, "interaction", turnId, announce);
        return pendingInteractionResolutionSchema.parse(answer);
      },
      callTool: async ({ callId, tool, arguments: input, turnId }) => {
        const announce = (_: LiveSession, requestId: string) => {
          const ids = { threadId, turnId, requestId, callId };
          const kind = "toolCall.requested";
          outbox.emit({ kind, ...ids, tool, arguments: input });
        };
        const answer = await request(live, "toolCall", turnId, announce);
        return toolCallResponseSchema.parse(answer);
      },
    };
    const known = previous?.provider.providerThreadId ?? null;
    const resumable = {
      ...spec,
      providerThreadId: spec.providerThreadId ?? known,
    };
    const provider = await adapter.open(resumable, execution, host);
    const identity = { threadId, adapter, provider, events, envKey };
    const state = { pendingStart: null, closing: false, detached: false };
    const requests = new Map<string, PendingRequest>();
    const activity = { lastActiveAt: Date.now(), requests };
    live = { ...identity, ...state, ...activity, options: execution };
    sessions.set(threadId, live);
    events.flush();
    const { providerThreadId } = provider;
    const resolved = { providerThreadId, entries: env.entries };
    const type = "provider.env-resolved";
    outbox.threadEvent(threadId, { type, ...resolved, scope: threadScope() });
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

  async function submit(args: SubmitTurnArgs) {
    const { mode } = args;
    const live = sessions.get(args.session.threadId);
    if (mode.kind === "start") {
      if (live === undefined || !isBusy(live)) return startTurn(args);
      throw new RunnerError("competing_turn", "A turn is already running");
    }
    if (live !== undefined && mode.kind === "auto" && live.pendingStart) {
      const deadline = Date.now() + timing.interruptTimeoutMs;
      await waitFor(() => !live.pendingStart || live.closing, deadline);
    }
    const activeTurnId = live?.closing ? null : live?.events.activeTurnId;
    const turnId = mode.kind === "steer" ? mode.expectedTurnId : activeTurnId;
    if (live && turnId && activeTurnId === turnId) {
      const steering = { ...args, expectedTurnId: turnId };
      const outcome = await live.provider.steer(steering);
      const { providerThreadId } = live.provider;
      if (outcome === "steered") return { outcome, providerThreadId, turnId };
    }
    if (mode.kind === "steer") {
      const message = "The expected turn is no longer active";
      throw new RunnerError("stale_turn", message);
    }
    if (live !== undefined && !live.closing && isBusy(live)) {
      throw new RunnerError("competing_turn", "A turn is already starting");
    }
    return startTurn(args);
  }

  function remember(args: SubmitTurnArgs) {
    const { threadId } = args.session;
    const fresh = new Map<string, Promise<SubmitTurnResult>>();
    const byRequest = remembered.get(threadId) ?? fresh;
    remembered.set(threadId, byRequest);
    const known = byRequest.get(args.clientRequestId);
    if (known !== undefined) return known;
    const result = serialize(threadId, () => submit(args)).catch((error) => {
      byRequest.delete(args.clientRequestId);
      throw toRunnerError(error);
    });
    byRequest.set(args.clientRequestId, result);
    const [oldest] = byRequest.keys();
    if (byRequest.size > MAX_REMEMBERED_REQUESTS) byRequest.delete(oldest);
    return result;
  }

  async function interrupt(threadId: string) {
    const live = sessions.get(threadId);
    if (live === undefined || !isBusy(live)) return { interrupted: false };
    const deadline = Date.now() + timing.interruptTimeoutMs;
    void live.provider.interrupt().catch(() => undefined);
    await waitFor(() => live.closing || !isBusy(live), deadline);
    live.events.settle("interrupted");
    await closeSession(live, "interrupted");
    return { interrupted: true };
  }

  function watch() {
    const now = Date.now();
    for (const live of sessions.values()) {
      const start = live.pendingStart;
      const limitMs = timing.turnStartTimeoutMs;
      if (start && !start.warned && now - start.since >= limitMs) {
        start.warned = true;
        const code = "provider_turn_start_timeout";
        const message = `The provider accepted a turn but did not start it within ${Math.round(limitMs / 1000)}s. The request may be stalled; stopping the thread interrupts it.`;
        systemError(live, null, { code, message });
      }
      const quiet = now - live.lastActiveAt >= timing.idleReapMs;
      const waiting = live.requests.size > 0 || isBusy(live);
      if (!quiet || waiting || live.events.hasOpenBackgroundWork()) continue;
      const reap = async () => {
        if (!isBusy(live)) await closeSession(live, "idle");
      };
      void serialize(live.threadId, reap);
    }
  }

  const watchdog = setInterval(watch, timing.watchdogIntervalMs).unref();

  return {
    describe: async () => ({
      instanceId,
      version: "0.0.1",
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
        pendingRequestIds: live.flatMap((s) => [...s.requests.keys()]),
        terminalIds: options.terminalIds?.() ?? [],
        lastEventSeq: outbox.lastSeq,
      };
    },
    ackEvents: async ({ seq }) => outbox.ack(seq),
    listProviders: () => Promise.all(listAdapters().map((a) => a.status())),
    listModels: async (args) =>
      adapterFor(args.providerId).listModels(args.cwd),
    submitTurn: (args) => {
      const env = Object.entries(args.session.env).map(([name, value]) => [
        name,
        value.replaceAll(SERVER_URL_PLACEHOLDER, options.serverUrl),
      ]);
      const session = { ...args.session, env: Object.fromEntries(env) };
      return remember({ ...args, session });
    },
    interruptTurn: ({ threadId }) =>
      serialize(threadId, () => interrupt(threadId)),
    releaseSession: ({ threadId }) =>
      serialize(threadId, async () => {
        const live = sessions.get(threadId);
        if (live && !isBusy(live)) await closeSession(live, "released");
      }),
    resolveInteraction: async ({ threadId, requestId, resolution }) =>
      deliver(threadId, requestId, resolution),
    resolveToolCall: async ({ threadId, requestId, result }) =>
      deliver(threadId, requestId, result),
    renameSession: async ({ threadId, title }) => {
      await sessions.get(threadId)?.provider.rename?.(title);
    },
    deleteThreadStorage: ({ threadId }) =>
      serialize(threadId, async () => {
        const valid = THREAD_ID.test(threadId);
        if (!valid) throw new RunnerError("invalid_path", "Invalid thread id");
        await interrupt(threadId);
        const live = sessions.get(threadId);
        if (live !== undefined) await closeSession(live, "deleted");
        remembered.delete(threadId);
        await rm(join(storageRoot, threadId), { recursive: true, force: true });
      }),
    shutdown: async () => {
      clearInterval(watchdog);
      const live = [...sessions.values()];
      await Promise.all(live.map((s) => closeSession(s, "shutdown")));
      outbox.flush();
    },
  };
}
