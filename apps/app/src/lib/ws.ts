import ReconnectingWebSocket from "partysocket/ws";
import {
  changedMessageLenientSchema,
  pluginSignalLenientSchema,
  realtimeSubscriptionTargetKey,
  threadOpenSignalLenientSchema,
} from "@bb/server-contract";
import type {
  ClientMessage,
  ChangedMessage,
  PluginSignal,
  RealtimeSubscriptionTarget,
  ThreadOpenFile,
  ThreadOpenSignal,
} from "@bb/server-contract";
import { presenceMessageSchema, type UserPresence } from "@bb/domain";
import { buildBrowserWebSocketUrl } from "./browser-websocket-url";

export type WebSocketConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting";

type Listener<T> = (value: T) => void;

const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 5_000;
const GLOBAL_TARGETS: readonly RealtimeSubscriptionTarget[] = [
  { kind: "system" },
  { kind: "thread-list" },
  { kind: "project-list" },
  { kind: "environment-list" },
  { kind: "host-list" },
];

function createEmitter<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    emit: (value: T) => listeners.forEach((listener) => listener(value)),
    on: (listener: Listener<T>) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

class WebSocketManager {
  private socket: ReconnectingWebSocket | null = null;
  private state: WebSocketConnectionState = "connecting";
  private hasConnected = false;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly targets = new Map<
    string,
    { count: number; target: RealtimeSubscriptionTarget }
  >();
  private readonly pendingOpenFiles = new Map<string, ThreadOpenFile>();
  private readonly changed = createEmitter<ChangedMessage>();
  private readonly threadOpen = createEmitter<ThreadOpenSignal>();
  private readonly pluginSignal = createEmitter<PluginSignal>();
  private readonly connected = createEmitter<boolean>();
  private readonly stateChanged = createEmitter<void>();
  private readonly presence = createEmitter<UserPresence[]>();
  private viewedThreadIds: string[] = [];

  readonly onChanged = this.changed.on;
  readonly onThreadOpen = this.threadOpen.on;
  readonly onPluginSignal = this.pluginSignal.on;
  readonly onConnected = this.connected.on;
  readonly onConnectionStateChange = this.stateChanged.on;
  readonly onPresence = this.presence.on;

  connect(): void {
    if (this.socket) return;
    const socket = new ReconnectingWebSocket(
      buildBrowserWebSocketUrl("/ws"),
      undefined,
      {
        minReconnectionDelay: 1000,
        maxReconnectionDelay: 10_000,
        reconnectionDelayGrowFactor: 1.5,
        connectionTimeout: 10_000,
        maxRetries: Infinity,
      },
    );
    this.socket = socket;
    socket.onopen = () => {
      const reconnected = this.hasConnected;
      this.hasConnected = true;
      this.setState("connected");
      for (const target of GLOBAL_TARGETS) {
        this.send({ type: "subscribe", target });
      }
      for (const { target } of this.targets.values()) {
        this.send({ type: "subscribe", target });
      }
      this.send({ type: "presence", threadIds: this.viewedThreadIds });
      this.connected.emit(reconnected);
    };
    socket.onmessage = (event: MessageEvent) => {
      this.clearPongTimer();
      if (typeof event.data === "string") this.receive(event.data);
    };
    socket.onclose = () => {
      this.clearPongTimer();
      this.setState(this.hasConnected ? "reconnecting" : "connecting");
    };
    setInterval(() => this.probe(), PING_INTERVAL_MS);
    window.addEventListener("online", () => this.probe());
    document.addEventListener("visibilitychange", () => this.probe());
  }

  subscribe(target: RealtimeSubscriptionTarget): () => void {
    const key = realtimeSubscriptionTargetKey(target);
    const entry = this.targets.get(key) ?? { count: 0, target };
    this.targets.set(key, entry);
    entry.count += 1;
    if (entry.count === 1) this.send({ type: "subscribe", target });
    return () => {
      entry.count -= 1;
      if (entry.count > 0) return;
      this.targets.delete(key);
      this.send({ type: "unsubscribe", target });
    };
  }

  setViewedThreads(threadIds: readonly string[]): void {
    const next = [...new Set(threadIds)].sort().slice(0, 16);
    if (next.join("\n") === this.viewedThreadIds.join("\n")) return;
    this.viewedThreadIds = next;
    this.send({ type: "presence", threadIds: next });
  }

  consumePendingOpenFile(threadId: string): ThreadOpenFile | null {
    const pending = this.pendingOpenFiles.get(threadId) ?? null;
    this.pendingOpenFiles.delete(threadId);
    return pending;
  }

  getConnectionState(): WebSocketConnectionState {
    return this.state;
  }

  private probe(): void {
    if (document.hidden || this.pongTimer !== null) return;
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.send({ type: "ping" });
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      this.socket?.reconnect();
    }, PONG_TIMEOUT_MS);
  }

  private clearPongTimer(): void {
    if (this.pongTimer !== null) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private receive(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const threadOpen = threadOpenSignalLenientSchema.safeParse(parsed);
    if (threadOpen.success) {
      const { file, threadId } = threadOpen.data;
      if (file !== null) this.pendingOpenFiles.set(threadId, file);
      this.threadOpen.emit(threadOpen.data);
      return;
    }
    const pluginSignal = pluginSignalLenientSchema.safeParse(parsed);
    if (pluginSignal.success) {
      this.pluginSignal.emit(pluginSignal.data);
      return;
    }
    const changed = changedMessageLenientSchema.safeParse(parsed);
    if (changed.success) {
      this.changed.emit(changed.data);
      return;
    }
    const presence = presenceMessageSchema.safeParse(parsed);
    if (presence.success) this.presence.emit(presence.data.users);
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private setState(next: WebSocketConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.stateChanged.emit();
  }
}

export const wsManager = new WebSocketManager();
