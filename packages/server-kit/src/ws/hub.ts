import * as domain from "@bb/domain";
import type {
  ChangeListener,
  Realtime,
  SubscriptionListener,
} from "@bb/plugin";
import type { PluginSignal, ThreadOpenSignal } from "@bb/server-contract";
import type { ZodType } from "zod";

export interface HubSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type { ChangeListener, SubscriptionListener };

type ThreadChangedMessage = Extract<
  domain.ChangedMessage,
  { entity: "thread" }
>;

interface Subscription {
  target: domain.RealtimeSubscriptionTarget;
  sockets: Set<HubSocket>;
}

interface Viewer {
  userId: string | null;
  threadIds: readonly string[];
}

interface PendingListEvents {
  eventTypes: Set<domain.ThreadEventType>;
  merged: boolean;
  timer: ReturnType<typeof setTimeout>;
}

const LIST_EVENTS_COALESCE_MS = 1_000;
const INVALID_MESSAGE_CLOSE_CODE = 1008;
const LIST_RELEVANT_EVENT_TYPES: ReadonlySet<domain.ThreadEventType> = new Set([
  "client/turn/requested",
  "turn/completed",
]);

function isListRelevant(message: ThreadChangedMessage) {
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

export function parseFrame<T>(schema: ZodType<T>, raw: string): T | null {
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function subscriptionKeys(message: domain.ChangedMessage) {
  const { entity } = message;
  if (entity === "system") return ["system"];
  return [`${entity}-list`, `${entity}-detail:${message.id}`];
}

export class Hub implements Realtime {
  private readonly keysBySocket = new Map<HubSocket, Set<string>>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly pendingListEvents = new Map<string, PendingListEvents>();
  private readonly subscriptionListeners = new Set<SubscriptionListener>();
  private readonly changeListeners = new Set<ChangeListener>();
  private readonly viewers = new Map<HubSocket, Viewer>();
  private announcedPresence = "[]";

  thread(
    id: string,
    changes: domain.ThreadChangeKind[],
    metadata?: domain.ThreadChangeMetadata,
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
    const eventTypes = new Set<domain.ThreadEventType>();
    this.pendingListEvents.set(id, { eventTypes, merged: false, timer });
  }

  project(id: string, changes: domain.ProjectChangeKind[]): void {
    this.publish({ type: "changed", entity: "project", id, changes });
  }

  environment(id: string, changes: domain.EnvironmentChangeKind[]): void {
    this.publish({ type: "changed", entity: "environment", id, changes });
  }

  host(id: string, changes: domain.HostChangeKind[]): void {
    this.publish({ type: "changed", entity: "host", id, changes });
  }

  system(changes: domain.SystemChangeKind[]): void {
    this.publish({ type: "changed", entity: "system", changes });
  }

  pluginSignal(pluginId: string, channel: string, payload: unknown): number {
    const type = "plugin-signal";
    const signal: PluginSignal = { type, pluginId, channel, payload };
    return this.send(this.keysBySocket.keys(), signal);
  }

  threadOpen(
    signal: Omit<ThreadOpenSignal, "type">,
    userId: string | null = null,
  ): number {
    const message: ThreadOpenSignal = { type: "thread-open", ...signal };
    const own = [...this.viewers]
      .filter(([, viewer]) => userId !== null && viewer.userId === userId)
      .map(([socket]) => socket);
    return this.send(own.length > 0 ? own : this.keysBySocket.keys(), message);
  }

  presence(): domain.UserPresence[] {
    const threadsByUser = new Map<string, Set<string>>();
    for (const { userId, threadIds } of this.viewers.values()) {
      if (userId === null) continue;
      const viewed = threadsByUser.get(userId) ?? new Set<string>();
      threadsByUser.set(userId, viewed);
      for (const threadId of threadIds) viewed.add(threadId);
    }
    return [...threadsByUser]
      .map(([userId, viewed]) => ({ userId, threadIds: [...viewed].sort() }))
      .sort((left, right) => left.userId.localeCompare(right.userId));
  }

  onSubscriptionChange(listener: SubscriptionListener): () => void {
    this.subscriptionListeners.add(listener);
    return () => this.subscriptionListeners.delete(listener);
  }

  onChanged(listener: ChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  connect(socket: HubSocket, userId: string | null = null): void {
    this.keysBySocket.set(socket, this.keysBySocket.get(socket) ?? new Set());
    if (userId === null || this.viewers.has(socket)) return;
    this.viewers.set(socket, { userId, threadIds: [] });
    if (this.announcePresence()) return;
    this.send([socket], { type: "presence", users: this.presence() });
  }

  disconnect(socket: HubSocket): void {
    for (const key of this.keysBySocket.get(socket) ?? []) {
      this.unsubscribe(socket, key);
    }
    this.keysBySocket.delete(socket);
    if (this.viewers.delete(socket)) this.announcePresence();
  }

  receive(socket: HubSocket, raw: string): void {
    const message = parseFrame(domain.clientMessageSchema, raw);
    if (message === null) {
      socket.close(INVALID_MESSAGE_CLOSE_CODE, "invalid-message");
    } else if (message.type === "ping") {
      this.send([socket], { type: "pong" });
    } else if (message.type === "subscribe") {
      this.subscribe(socket, message.target);
    } else if (message.type === "presence") {
      const viewer = this.viewers.get(socket);
      if (viewer === undefined) return;
      this.viewers.set(socket, { ...viewer, threadIds: message.threadIds });
      this.announcePresence();
    } else {
      this.unsubscribe(
        socket,
        domain.realtimeSubscriptionTargetKey(message.target),
      );
    }
  }

  close(): void {
    for (const pending of this.pendingListEvents.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingListEvents.clear();
  }

  private announcePresence(): boolean {
    const users = this.presence();
    const encoded = JSON.stringify(users);
    if (encoded === this.announcedPresence) return false;
    this.announcedPresence = encoded;
    this.send([...this.viewers.keys()], { type: "presence", users });
    return true;
  }

  private subscribe(
    socket: HubSocket,
    target: domain.RealtimeSubscriptionTarget,
  ) {
    const key = domain.realtimeSubscriptionTargetKey(target);
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

  private publish(message: domain.ChangedMessage): void {
    for (const listener of this.changeListeners) listener(message);
    this.route(message);
  }

  private route(message: domain.ChangedMessage): void {
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
