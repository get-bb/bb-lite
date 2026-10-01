import type { RunnerEvent, RunnerEventSink, SessionApi } from "@bb/runner";
import type { Logger } from "../context.js";
import { hostUnavailable } from "../http/errors.js";

export type RunnerEventKind = RunnerEvent["kind"];
export type RunnerEventOf<Kind extends RunnerEventKind> = Extract<
  RunnerEvent,
  { kind: Kind }
>;
export type RunnerEventHandler<Kind extends RunnerEventKind> = (
  event: RunnerEventOf<Kind>,
  hostId: string,
) => void | Promise<void>;
export type RunnerFactory<R> = (sink: RunnerEventSink) => R;
type HostListener = (hostId: string) => void;
type AnyHandler = (event: RunnerEvent, hostId: string) => void | Promise<void>;

interface Connection<R> {
  runner: R;
  acknowledged: Promise<void>;
}

export interface RunnerRegistryOptions<R> {
  localHostId: string;
  localRunner: RunnerFactory<R>;
  log: Logger;
}

export class RunnerRegistry<R extends SessionApi> {
  readonly localHostId: string;
  private readonly log: Logger;
  private readonly connections = new Map<string, Connection<R>>();
  private readonly handlers = new Map<RunnerEventKind, Set<AnyHandler>>();
  private readonly connectListeners = new Set<HostListener>();
  private readonly disconnectListeners = new Set<HostListener>();

  constructor(options: RunnerRegistryOptions<R>) {
    this.localHostId = options.localHostId;
    this.log = options.log;
    this.connect(options.localHostId, options.localRunner);
  }

  get(hostId: string): R {
    const connection = this.connections.get(hostId);
    if (connection === undefined) throw hostUnavailable();
    return connection.runner;
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
    connection = { runner, acknowledged: Promise.resolve() };
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
