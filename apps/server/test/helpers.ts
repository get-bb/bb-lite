import { mkdtempSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import type { RealtimeSubscriptionTarget } from "@bb/domain";
import {
  createWorkspaceApi,
  RunnerError,
  type RunnerEventSink,
} from "@bb/runner";
import { createApiClient } from "@bb/server-contract";
import { onTestFinished } from "vitest";
import { WebSocket } from "ws";
import { loadConfig, type ServerConfig } from "../src/config.js";
import type { ServerRunner } from "../src/context.js";
import { openDatabase } from "../src/db/index.js";
import type { RunnerFactory } from "../src/runners/registry.js";
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

  constructor(readonly socket: WebSocket) {
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

  send(message: object): void {
    this.socket.send(JSON.stringify(message));
  }

  async subscribe(target: RealtimeSubscriptionTarget): Promise<void> {
    this.send({ type: "subscribe", target });
    this.send({ type: "ping" });
    await this.next((message) => message.type === "pong");
  }
}

export const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
};

function scriptRealWorkspace(runner: FakeRunner, dataDir: string): void {
  const workspace = createWorkspaceApi({
    dataDir,
    env: async () => GIT_ENV,
    sink: (event) => void (event.lane === "live" && runner.emit(event)),
  });
  Object.assign(runner.script, workspace.api);
  onTestFinished(() => workspace.dispose());
}

export async function createTestServer(
  overrides: Partial<ServerConfig> = {},
  options: {
    realWorkspace?: boolean;
    databasePath?: string;
    localRunner?: (config: ServerConfig) => RunnerFactory<ServerRunner>;
  } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), "bb-server-test-"));
  const env = { BB_DATA_DIR: dataDir, BB_SERVER_PORT: "0" };
  const logLevel = "silent" as const;
  const config = { ...loadConfig(env), logLevel, ...overrides };
  const clock = { now: 1_700_000_000_000 };
  const now = (): number => clock.now;
  const runner = new FakeRunner();
  if (options.realWorkspace) scriptRealWorkspace(runner, dataDir);
  const server = createServer({
    config,
    now,
    db: openDatabase({ path: options.databasePath ?? ":memory:", now }),
    localRunner:
      options.localRunner?.(config) ??
      ((sink) => {
        runner.emit = sink;
        return runner.api;
      }),
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
    socket: (path = "/ws"): Promise<TestSocket> =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`${url.replace("http", "ws")}${path}`);
        socket.on("open", () => resolve(new TestSocket(socket)));
        socket.on("error", reject);
      }),
  };
}
