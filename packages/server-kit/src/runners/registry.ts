import {
  describeInput,
  type AuditRecord,
  type Caller,
  type Op,
  type RunnerEventHandler,
  type RunnerEventKind,
  type RunnerEventOf,
  type RunnerFactory,
} from "@bb/plugin";
import type { Runner, RunnerEvent } from "@bb/runner";
import type { z } from "zod";
import type { Logger } from "../context.js";
import { hostUnavailable } from "../http/errors.js";

export type {
  RunnerEventHandler,
  RunnerEventKind,
  RunnerEventOf,
  RunnerFactory,
};
type HostListener = (hostId: string) => void;
type AnyHandler = (event: RunnerEvent, hostId: string) => void | Promise<void>;

interface Connection<R> {
  runner: R;
  bound: R;
  acknowledged: Promise<void>;
}

export interface RunnerRegistryOptions<R> {
  localHostId: string;
  localRunner: RunnerFactory<R>;
  log: Logger;
  authorize?: (hostId: string) => void;
  currentCaller?: () => Caller;
  record?: (entry: AuditRecord) => void;
  now?: () => number;
}

export class RunnerRegistry<R extends Runner> {
  readonly localHostId: string;
  private readonly log: Logger;
  private readonly authorize: (hostId: string) => void;
  private readonly observed: Pick<
    RunnerRegistryOptions<R>,
    "currentCaller" | "record"
  >;
  private readonly now: () => number;
  private readonly connections = new Map<string, Connection<R>>();
  private readonly handlers = new Map<RunnerEventKind, Set<AnyHandler>>();
  private readonly connectListeners = new Set<HostListener>();
  private readonly disconnectListeners = new Set<HostListener>();

  constructor(options: RunnerRegistryOptions<R>) {
    this.localHostId = options.localHostId;
    this.log = options.log;
    this.authorize = options.authorize ?? (() => {});
    this.observed = options;
    this.now = options.now ?? Date.now;
    this.connect(options.localHostId, options.localRunner);
  }

  get(hostId: string): R {
    this.authorize(hostId);
    const connection = this.connections.get(hostId);
    if (connection === undefined) throw hostUnavailable();
    return connection.bound;
  }

  private bind(hostId: string, runner: R): R {
    const call: Runner["call"] = async (op, input, options = {}) => {
      const caller = options.caller ?? this.observed.currentCaller?.();
      const startedAt = this.now();
      const finish = (outcome: "ok" | "error", detail: string | null) => {
        if (op.kind !== "write" || !op.audit || caller === undefined) return;
        this.observed.record?.({
          at: startedAt,
          op: op.name,
          kind: op.kind,
          caller,
          hooks: [],
          outcome,
          detail,
          durationMs: this.now() - startedAt,
          input: describeInput(op, { hostId, ...(input as object) }),
        });
      };
      try {
        const result = await runner.call(op, input, { ...options, caller });
        finish("ok", null);
        return result;
      } catch (error) {
        finish("error", error instanceof Error ? error.message : String(error));
        throw error;
      }
    };
    return new Proxy(runner, {
      get: (target, key, receiver) =>
        key === "call" ? call : (Reflect.get(target, key, receiver) as unknown),
    });
  }

  connectedHostIds(): string[] {
    return [...this.connections.keys()];
  }

  isConnected(hostId: string): boolean {
    return this.connections.has(hostId);
  }

  connect(hostId: string, create: RunnerFactory<R>): R {
    this.disconnect(hostId);
    let connection: Connection<R> | undefined;
    const runner = create((event) => {
      if (connection !== undefined) this.deliver(hostId, connection, event);
    });
    const bound = this.bind(hostId, runner);
    connection = { runner, bound, acknowledged: Promise.resolve() };
    this.connections.set(hostId, connection);
    for (const listener of this.connectListeners) listener(hostId);
    return runner;
  }

  disconnect(hostId: string, runner?: R): void {
    const connection = this.connections.get(hostId);
    if (connection === undefined) return;
    if (runner !== undefined && connection.runner !== runner) return;
    this.connections.delete(hostId);
    for (const listener of this.disconnectListeners) listener(hostId);
  }

  onEvent<Kind extends RunnerEventKind>(
    kind: Kind,
    handler: RunnerEventHandler<Kind>,
  ): () => void {
    const handlers = this.handlers.get(kind) ?? new Set<AnyHandler>();
    this.handlers.set(kind, handlers);
    const entry = handler as AnyHandler;
    handlers.add(entry);
    return () => handlers.delete(entry);
  }

  onConnected(listener: HostListener): () => void {
    this.connectListeners.add(listener);
    return () => this.connectListeners.delete(listener);
  }

  onDisconnected(listener: HostListener): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  call<O extends Op>(
    hostId: string,
    op: O,
    input: z.input<O["input"]>,
    options?: { timeoutMs?: number },
  ): Promise<z.output<O["output"]>> {
    return this.get(hostId).call(op, input, options);
  }

  async emit(hostId: string, event: RunnerEvent): Promise<void> {
    const handlers = [...(this.handlers.get(event.kind) ?? [])];
    const settled = await Promise.allSettled(
      handlers.map(async (handler) => handler(event, hostId)),
    );
    for (const result of settled) {
      if (result.status === "fulfilled") continue;
      const { kind } = event;
      this.log.error("Runner event handler failed", {
        err: result.reason,
        hostId,
        kind,
      });
    }
  }

  private deliver(
    hostId: string,
    connection: Connection<R>,
    event: RunnerEvent,
  ): void {
    if (this.connections.get(hostId) !== connection) return;
    const handled = this.emit(hostId, event);
    if (event.lane !== "reliable") return;
    connection.acknowledged = connection.acknowledged
      .then(() => handled)
      .then(() => connection.runner.ackEvents({ seq: event.seq }))
      .catch((error: unknown) => {
        this.log.warn("Runner event acknowledgement failed", {
          err: error,
          hostId,
        });
      });
  }
}
