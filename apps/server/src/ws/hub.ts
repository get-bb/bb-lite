import {
  clientMessageSchema,
  realtimeSubscriptionTargetKey as targetKey,
  type ChangedMessage,
  type ClientMessage,
  type EnvironmentChangeKind,
  type HostChangeKind,
  type ProjectChangeKind,
  type RealtimeSubscriptionTarget,
  type SystemChangeKind,
  type ThreadChangeKind,
  type ThreadChangeMetadata,
  type ThreadEventType,
} from "@bb/domain";
import type { PluginSignal, ThreadOpenSignal } from "@bb/server-contract";

export interface HubSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SubscriptionListener = (
  target: RealtimeSubscriptionTarget,
  subscribed: boolean,
) => void;

export type ChangeListener = (message: ChangedMessage) => void;

type ThreadChangedMessage = Extract<ChangedMessage, { entity: "thread" }>;

interface Subscription {
  target: RealtimeSubscriptionTarget;
  sockets: Set<HubSocket>;
}

interface PendingListEvents {
  eventTypes: Set<ThreadEventType>;
  merged: boolean;
  timer: ReturnType<typeof setTimeout>;
}

const LIST_EVENTS_COALESCE_MS = 1_000;
const INVALID_MESSAGE_CLOSE_CODE = 1008;
const LIST_RELEVANT_EVENT_TYPES: ReadonlySet<ThreadEventType> = new Set([
  "client/turn/requested",
  "turn/completed",
]);

function isListRelevant(message: ThreadChangedMessage): boolean {
  if (message.changes.some((change) => change !== "events-appended")) {
    return true;
  }
  const metadata = message.metadata ?? {};
  return (
    metadata.backgroundActivityChanged === true ||
    metadata.hasPendingInteraction !== undefined ||
    metadata.projectId !== undefined ||
    (metadata.eventTypes ?? []).some((type) =>
      LIST_RELEVANT_EVENT_TYPES.has(type),
    )
  );
}

function parseClientMessage(raw: string): ClientMessage | null {
  try {
    return clientMessageSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function subscriptionKeys(message: ChangedMessage): string[] {
  const { entity } = message;
  if (entity === "system") return ["system"];
  return [`${entity}-list`, `${entity}-detail:${message.id}`];
}

export class Hub {
  private readonly keysBySocket = new Map<HubSocket, Set<string>>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly pendingListEvents = new Map<string, PendingListEvents>();
  private readonly subscriptionListeners = new Set<SubscriptionListener>();
  private readonly changeListeners = new Set<ChangeListener>();

  thread(
    id: string,
    changes: ThreadChangeKind[],
    metadata?: ThreadChangeMetadata,
  ): void {
    const message: ThreadChangedMessage = {
      type: "changed",
      entity: "thread",
      id,
      changes,
      ...(metadata === undefined ? {} : { metadata }),
    };
    for (const listener of this.changeListeners) listener(message);
    if (isListRelevant(message)) {
      this.route(message);
      return;
    }
    this.send(this.subscribers(`thread-detail:${id}`), message);
    const pending = this.pendingListEvents.get(id);
    if (pending !== undefined) {
      for (const type of metadata?.eventTypes ?? []) {
        pending.eventTypes.add(type);
      }
      pending.merged = true;
      return;
    }
    this.send(this.listOnlySubscribers(id), message);
    const timer = setTimeout(
      () => this.flushListEvents(id),
      LIST_EVENTS_COALESCE_MS,
    );
    timer.unref();
    const eventTypes = new Set<ThreadEventType>();
    this.pendingListEvents.set(id, { eventTypes, merged: false, timer });
  }

  project(id: string, changes: ProjectChangeKind[]): void {
    this.publish({ type: "changed", entity: "project", id, changes });
  }

  environment(id: string, changes: EnvironmentChangeKind[]): void {
    this.publish({ type: "changed", entity: "environment", id, changes });
  }

  host(id: string, changes: HostChangeKind[]): void {
    this.publish({ type: "changed", entity: "host", id, changes });
  }

  system(changes: SystemChangeKind[]): void {
    this.publish({ type: "changed", entity: "system", changes });
  }

  pluginSignal(pluginId: string, channel: string, payload: unknown): number {
    const type = "plugin-signal";
    const signal: PluginSignal = { type, pluginId, channel, payload };
    return this.send(this.keysBySocket.keys(), signal);
  }

  threadOpen(signal: Omit<ThreadOpenSignal, "type">): number {
    const message: ThreadOpenSignal = { type: "thread-open", ...signal };
    return this.send(this.keysBySocket.keys(), message);
  }

  hasSubscribers(target: RealtimeSubscriptionTarget): boolean {
    return this.subscriptions.has(targetKey(target));
  }

  onSubscriptionChange(listener: SubscriptionListener): () => void {
    this.subscriptionListeners.add(listener);
    return () => this.subscriptionListeners.delete(listener);
  }

  onChanged(listener: ChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  connect(socket: HubSocket): void {
    this.keysBySocket.set(socket, this.keysBySocket.get(socket) ?? new Set());
  }

  disconnect(socket: HubSocket): void {
    for (const key of this.keysBySocket.get(socket) ?? []) {
      this.unsubscribe(socket, key);
    }
    this.keysBySocket.delete(socket);
  }

  receive(socket: HubSocket, raw: string): void {
    const message = parseClientMessage(raw);
    if (message === null) {
      socket.close(INVALID_MESSAGE_CLOSE_CODE, "invalid-message");
    } else if (message.type === "ping") {
      this.send([socket], { type: "pong" });
    } else if (message.type === "subscribe") {
      this.subscribe(socket, message.target);
    } else {
      this.unsubscribe(socket, targetKey(message.target));
    }
  }

  close(): void {
    for (const pending of this.pendingListEvents.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingListEvents.clear();
  }

  private subscribe(socket: HubSocket, target: RealtimeSubscriptionTarget) {
    const key = targetKey(target);
    this.connect(socket);
    this.keysBySocket.get(socket)?.add(key);
    const existing = this.subscriptions.get(key);
    if (existing !== undefined) {
      existing.sockets.add(socket);
      return;
    }
    this.subscriptions.set(key, { target, sockets: new Set([socket]) });
    for (const listener of this.subscriptionListeners) listener(target, true);
  }

  private unsubscribe(socket: HubSocket, key: string): void {
    this.keysBySocket.get(socket)?.delete(key);
    const subscription = this.subscriptions.get(key);
    if (subscription === undefined) return;
    subscription.sockets.delete(socket);
    if (subscription.sockets.size > 0) return;
    this.subscriptions.delete(key);
    for (const listener of this.subscriptionListeners) {
      listener(subscription.target, false);
    }
  }

  private subscribers(key: string): HubSocket[] {
    return [...(this.subscriptions.get(key)?.sockets ?? [])];
  }

  private listOnlySubscribers(threadId: string): HubSocket[] {
    const detailKey = `thread-detail:${threadId}`;
    return this.subscribers("thread-list").filter(
      (socket) => !this.keysBySocket.get(socket)?.has(detailKey),
    );
  }

  private publish(message: ChangedMessage): void {
    for (const listener of this.changeListeners) listener(message);
    this.route(message);
  }

  private route(message: ChangedMessage): void {
    const sockets = subscriptionKeys(message).flatMap((key) =>
      this.subscribers(key),
    );
    this.send(new Set(sockets), message);
  }

  private flushListEvents(id: string): void {
    const pending = this.pendingListEvents.get(id);
    this.pendingListEvents.delete(id);
    if (pending === undefined || !pending.merged) return;
    const eventTypes = [...pending.eventTypes];
    const message: ThreadChangedMessage = {
      type: "changed",
      entity: "thread",
      id,
      changes: ["events-appended"],
      ...(eventTypes.length === 0 ? {} : { metadata: { eventTypes } }),
    };
    this.send(this.listOnlySubscribers(id), message);
  }

  private send(sockets: Iterable<HubSocket>, message: object): number {
    const payload = JSON.stringify(message);
    let delivered = 0;
    for (const socket of sockets) {
      try {
        socket.send(payload);
        delivered += 1;
      } catch {
        this.disconnect(socket);
      }
    }
    return delivered;
  }
}
