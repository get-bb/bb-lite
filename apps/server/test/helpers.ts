import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RealtimeSubscriptionTarget } from "@bb/domain";
import { RunnerError, type RunnerEventSink } from "@bb/runner";
import { createApiClient } from "@bb/server-contract";
import { onTestFinished } from "vitest";
import { WebSocket } from "ws";
import { loadConfig, type ServerConfig } from "../src/config.js";
import type { ServerRunner } from "../src/context.js";
import { openDatabase } from "../src/db/index.js";
import { createServer } from "../src/server.js";

export type SocketMessage = { type: string } & Record<string, unknown>;
type Matcher = (message: SocketMessage) => boolean;
const NEXT_MESSAGE_TIMEOUT_MS = 2_000;

export class FakeRunner {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly script: Partial<ServerRunner> = { ackEvents: async () => {} };
  emit: RunnerEventSink = () => {};
  readonly api = new Proxy({} as ServerRunner, {
    get: (_target, method) => this.call.bind(this, String(method)),
  });

  private call(method: string, ...args: unknown[]): unknown {
    this.calls.push({ method, args });
    const scripted: unknown = Reflect.get(this.script, method);
    if (typeof scripted === "function") return scripted(...args);
    const message = `FakeRunner.${method} is not scripted`;
    return Promise.reject(new RunnerError("failed", message));
  }
}

export class TestSocket {
  private readonly inbox: SocketMessage[] = [];
  private wake = (): void => {};

  constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      this.inbox.push(JSON.parse(data.toString()) as SocketMessage);
      this.wake();
    });
  }

  async next(matches: Matcher = () => true): Promise<SocketMessage> {
    const deadline = Date.now() + NEXT_MESSAGE_TIMEOUT_MS;
    for (;;) {
      const index = this.inbox.findIndex(matches);
      const [found] = index < 0 ? [] : this.inbox.splice(index, 1);
      if (found !== undefined) return found;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("No matching socket message arrived");
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        setTimeout(resolve, remaining);
      });
    }
  }

  async subscribe(target: RealtimeSubscriptionTarget): Promise<void> {
    this.socket.send(JSON.stringify({ type: "subscribe", target }));
    this.socket.send(JSON.stringify({ type: "ping" }));
    await this.next((message) => message.type === "pong");
  }
}

export async function createTestServer(overrides: Partial<ServerConfig> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "bb-server-test-"));
  const env = { BB_DATA_DIR: dataDir, BB_SERVER_PORT: "0" };
  const logLevel = "silent" as const;
  const config = { ...loadConfig(env), logLevel, ...overrides };
  const clock = { now: 1_700_000_000_000 };
  const now = (): number => clock.now;
  const runner = new FakeRunner();
  const server = createServer({
    config,
    now,
    db: openDatabase({ path: ":memory:", now }),
    localRunner: (sink) => {
      runner.emit = sink;
      return runner.api;
    },
  });
  const { url } = await server.listen();
  onTestFinished(async () => {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    ctx: server.ctx,
    url,
    api: createApiClient(url).api.v1,
    runner,
    clock,
    socket: (): Promise<TestSocket> =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`${url.replace("http", "ws")}/ws`);
        socket.on("open", () => resolve(new TestSocket(socket)));
        socket.on("error", reject);
      }),
  };
}
