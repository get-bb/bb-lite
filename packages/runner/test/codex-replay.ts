import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  EventBuilder,
  createCodexAdapter,
  type AppServerChild,
  type ExecutionOptions,
  type ProviderSession,
  type RunnerThreadEvent,
  type SessionHost,
  type SessionSpec,
} from "@bb/runner";

interface Message {
  id?: string | number;
  method?: string;
  params?: Record<string, any>;
  result?: unknown;
  error?: unknown;
}
interface WireEntry {
  from: "runtime" | "client" | "server";
  message: Message;
}
interface Pending {
  resolve(value: any): void;
}

const NEVER_SENT = new Set([
  "account/rateLimits/read",
  "skills/extraRoots/set",
]);
const RECORDER_ENV =
  "shell_environment_policy.set.BB_PROVIDER_BRIDGE_RECORD_DIR";
const FIXTURES = fileURLToPath(new URL("./fixtures/codex/", import.meta.url));

function readFixture(scenario: string, suffix: string) {
  return readFileSync(`${FIXTURES}${scenario}.${suffix}`, "utf8");
}

export function readOriginalEvents(scenario: string) {
  const events: unknown = JSON.parse(readFixture(scenario, "events.json"));
  return events as RunnerThreadEvent[];
}

function readWire(scenario: string) {
  const lines = readFixture(scenario, "wire.ndjson").split("\n");
  return lines.filter(Boolean).map((line) => JSON.parse(line) as WireEntry);
}

export function internIds<T>(events: T[]): T[] {
  const ids = new Map<string, string>();
  const intern = (id: string) => {
    if (!ids.has(id)) ids.set(id, `#${ids.size + 1}`);
    return ids.get(id) ?? id;
  };
  const json = JSON.stringify(events).replace(/da[0-9a-f]{8}-[ti]\d+/g, intern);
  return JSON.parse(json) as T[];
}

class FakeAppServer extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: Message[] = [];
  readonly stdin: Writable;
  private exited = false;

  constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        for (const line of chunk.toString().split("\n").filter(Boolean)) {
          this.written.push(JSON.parse(line) as Message);
        }
        done();
      },
      final: (done) => {
        this.exit();
        done();
      },
    });
  }

  kill() {
    this.exit();
    return true;
  }

  private exit() {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
  }
}

function tick() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

async function settle() {
  for (let round = 0; round < 3; round += 1) await tick();
}

function comparable(params: Record<string, any> = {}) {
  const { serviceTier, effort, excludeTurns, experimentalRawEvents, ...rest } =
    params;
  void [serviceTier, effort, excludeTurns, experimentalRawEvents];
  const config = { ...rest.config, [RECORDER_ENV]: undefined };
  const dynamicTools = rest.dynamicTools?.map(
    (tool: Record<string, unknown>) => ({ ...tool, type: undefined }),
  );
  const normalized = { ...rest, config, dynamicTools };
  return JSON.parse(JSON.stringify(normalized)) as Record<string, unknown>;
}

function toOptions(options: Record<string, any>): ExecutionOptions {
  return {
    model: options.model,
    reasoningLevel: options.reasoningLevel,
    serviceTier: options.serviceTier,
    permissionMode: options.permissionMode,
    permissionEscalation: options.permissionEscalation ?? "ask",
    planMode: false,
    providerOptions: options.providerOptions ?? {},
  };
}

function toSpec(params: Record<string, any>): SessionSpec {
  const source = params.sourceProviderThreadId;
  const checkpointId = params.sourceProviderCheckpointId ?? null;
  return {
    threadId: params.threadId,
    providerId: "codex",
    cwd: params.cwd,
    providerThreadId: params.providerThreadId ?? null,
    fork: source ? { sourceProviderThreadId: source, checkpointId } : null,
    instructions: params.options.instructions ?? "",
    dynamicTools: params.dynamicTools ?? [],
    env: {},
    skillDirs: [],
  };
}

export async function replayCodexRecording(scenario: string) {
  const events: RunnerThreadEvent[] = [];
  const mismatches: string[] = [];
  const hostRequests: Pending[] = [];
  const failures: unknown[] = [];
  let server: FakeAppServer | null = null;
  let builder: EventBuilder | null = null;
  let opening: Promise<ProviderSession> | null = null;
  let liveIds = new Map<string, string | number>();
  let skipped = new Set<string>();
  const track = (work: Promise<unknown>) =>
    void work.catch((e) => failures.push(e));
  const adapter = createCodexAdapter({
    command: "codex-replay",
    spawn: () => {
      server = new FakeAppServer();
      liveIds = new Map();
      skipped = new Set();
      return server as unknown as AppServerChild;
    },
  });
  const ask = <T>() =>
    new Promise<T>((resolve) => hostRequests.push({ resolve }));

  async function close() {
    if (opening === null) return;
    const session = await opening;
    opening = null;
    await session.close();
  }

  async function sent(describe: string, match: (message: Message) => boolean) {
    for (
      let attempt = 0;
      attempt < 500 && failures.length === 0;
      attempt += 1
    ) {
      const index = server?.written.findIndex(match) ?? -1;
      if (server && index !== -1) return server.written.splice(index, 1)[0];
      await (attempt < 20 ? settle() : new Promise((r) => setTimeout(r, 2)));
    }
    throw (
      failures[0] ??
      new Error(`${scenario}: the adapter never sent ${describe}`)
    );
  }

  function open(params: Record<string, any>) {
    const emit = (event: RunnerThreadEvent) => events.push(event);
    builder = new EventBuilder({ providerId: "codex", emit, textFlushMs: 0 });
    const host: SessionHost = {
      events: builder,
      env: params.options.envVars ?? {},
      processEnv: {},
      threadStorageDir: "/unused",
      writableRoots: [],
      callTool: () => ask(),
      requestInteraction: () => ask(),
      onExit: () => undefined,
    };
    opening = adapter.open(toSpec(params), toOptions(params.options), host);
    track(opening);
  }

  async function command({ method, params = {}, id, result }: Message) {
    if (method === undefined) {
      if (id !== undefined) hostRequests.shift()?.resolve(result);
      return;
    }
    if (/^thread\/(start|resume|fork)$/.test(method)) {
      await close();
      open(params);
      return;
    }
    if (opening === null || builder === null) return;
    const session = await opening;
    const input = {
      clientRequestId: params.clientRequestId,
      input: params.input,
    };
    const options = toOptions(params.options ?? {});
    if (method === "turn/start")
      track(session.startTurn({ ...input, options }));
    if (method === "turn/steer") {
      const expectedTurnId = builder.bbTurnId(params.expectedTurnId) ?? "";
      track(session.steer({ ...input, options, expectedTurnId }));
    }
    if (method !== "thread/stop") return;
    if (params.intent === "interrupt") track(session.interrupt());
    else await close();
  }

  async function expectation({ id, method, params, result }: Message) {
    if (method === undefined) {
      const answer = await sent(
        `a response to request ${id}`,
        (m) => m.id === id,
      );
      if (!isDeepStrictEqual(answer.result, result)) {
        mismatches.push(`response ${id}: ${JSON.stringify(answer.result)}`);
      }
      return;
    }
    if (NEVER_SENT.has(method)) {
      skipped.add(String(id));
      return;
    }
    const request = await sent(method, (m) => m.method === method);
    if (request.id !== undefined) liveIds.set(String(id), request.id);
    const [live, recorded] = [request.params, params].map(comparable);
    const keys = Object.keys({ ...live, ...recorded });
    const differing = keys.filter(
      (k) => !isDeepStrictEqual(live[k], recorded[k]),
    );
    if (differing.length > 0) mismatches.push(`${method}: ${differing.join()}`);
  }

  for (const { from, message } of readWire(scenario)) {
    if (from === "runtime") await command(message);
    if (from === "client") await expectation(message);
    if (from === "server") {
      const response = message.method === undefined;
      if (response && skipped.has(String(message.id))) continue;
      const id = response ? liveIds.get(String(message.id)) : message.id;
      (server as FakeAppServer | null)?.stdout.write(
        `${JSON.stringify({ ...message, id })}\n`,
      );
    }
    await settle();
  }
  await close();
  if (failures.length > 0) throw failures[0];
  return { events, mismatches };
}
