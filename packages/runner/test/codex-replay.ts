import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  dynamicToolSchema,
  pendingInteractionResolutionSchema,
  permissionEscalationValues,
  permissionModeSchema,
  promptInputSchema,
  reasoningLevelSchema,
  serviceTierSchema,
  toolCallResponseSchema,
} from "@bb/domain";
import { z } from "zod";
import {
  EventBuilder,
  createCodexAdapter,
  type AppServerChild,
  type ProviderSession,
  type RunnerThreadEvent,
  type SessionHost,
} from "@bb/runner";
import { settle } from "./kit.js";

const record = z.record(z.string(), z.unknown());
const optionsSchema = z.object({
  model: z.string(),
  reasoningLevel: reasoningLevelSchema,
  serviceTier: serviceTierSchema,
  permissionMode: permissionModeSchema,
  permissionEscalation: z.enum(permissionEscalationValues).nullish(),
  instructions: z.string().default(""),
  envVars: z.record(z.string(), z.string()).default({}),
  providerOptions: record.default({}),
});
const commandSchema = z.object({
  threadId: z.string(),
  cwd: z.string().default(""),
  providerThreadId: z.string().nullish(),
  sourceProviderThreadId: z.string().optional(),
  sourceProviderCheckpointId: z.string().optional(),
  options: optionsSchema.optional(),
  dynamicTools: z.array(dynamicToolSchema).default([]),
  clientRequestId: z.string().default(""),
  input: z.array(promptInputSchema).default([]),
  expectedTurnId: z.string().default(""),
  intent: z.string().optional(),
});
const messageSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: record.optional(),
  result: z.unknown().optional(),
});
const entrySchema = z.object({
  from: z.enum(["runtime", "client", "server"]),
  message: messageSchema,
});
type Message = z.infer<typeof messageSchema>;
type Command = z.infer<typeof commandSchema>;

const NEVER_SENT = new Set([
  "account/rateLimits/read",
  "skills/extraRoots/set",
]);
const NEWER_PARAMS = ["serviceTier", "effort", "excludeTurns"];
const UNSENT_PARAMS = ["experimentalRawEvents"];
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

class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: Message[] = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) this.written.push(JSON.parse(line) as Message);
    });
    this.stdin.on("finish", () => this.kill());
  }

  kill() {
    if (this.stdout.writableEnded) return true;
    this.stdout.end();
    this.emit("exit", 0, null);
    return this.emit("close", 0, null);
  }
}

function comparable(params: Record<string, unknown> = {}) {
  const ignored = [...NEWER_PARAMS, ...UNSENT_PARAMS];
  const kept = Object.entries(params).filter(([key]) => !ignored.includes(key));
  const rest = Object.fromEntries(kept);
  const config = { ...record.optional().parse(rest.config) };
  delete config[RECORDER_ENV];
  const tools = z.array(record).optional().parse(rest.dynamicTools);
  const dynamicTools = tools?.map((tool) => ({ ...tool, type: undefined }));
  const normalized = { ...rest, config, dynamicTools };
  return record.parse(JSON.parse(JSON.stringify(normalized)));
}

function toOptions(options: Command["options"]) {
  const { instructions, envVars, permissionEscalation, ...rest } =
    optionsSchema.parse(options ?? {});
  const escalation = permissionEscalation ?? "ask";
  const execution = {
    ...rest,
    permissionEscalation: escalation,
    planMode: false,
  };
  return { execution, instructions, envVars };
}

export async function replayCodexRecording(scenario: string) {
  const events: RunnerThreadEvent[] = [];
  const mismatches: string[] = [];
  const hostRequests: ((value: unknown) => void)[] = [];
  const failures: unknown[] = [];
  let server = new FakeAppServer();
  let builder: EventBuilder | null = null;
  let opening: Promise<ProviderSession> | null = null;
  let liveIds = new Map<string, string | number>();
  let skipped = new Set<string>();
  const track = (work: Promise<unknown>) =>
    void work.catch((e) => failures.push(e));
  const spawn = () => {
    server = new FakeAppServer();
    liveIds = new Map();
    skipped = new Set();
    return server as unknown as AppServerChild;
  };
  const adapter = createCodexAdapter({ command: "codex-replay", spawn });
  const ask = <T>(parse: (value: unknown) => T) =>
    new Promise<unknown>((resolve) => hostRequests.push(resolve)).then(parse);

  async function close() {
    const session = await opening;
    opening = null;
    await session?.close();
  }

  async function sent(describe: string, match: (message: Message) => boolean) {
    for (
      let attempt = 0;
      attempt < 500 && failures.length === 0;
      attempt += 1
    ) {
      const index = server.written.findIndex(match);
      if (index !== -1) return server.written.splice(index, 1)[0];
      await (attempt < 20 ? settle(3) : new Promise((r) => setTimeout(r, 2)));
    }
    const missing = `${scenario}: the adapter never sent ${describe}`;
    throw failures[0] ?? new Error(missing);
  }

  function open(command: Command) {
    const emit = (event: RunnerThreadEvent) => events.push(event);
    builder = new EventBuilder({ emit, textFlushMs: 0 });
    const { execution, instructions, envVars } = toOptions(command.options);
    const host: SessionHost = {
      events: builder,
      env: envVars,
      processEnv: {},
      threadStorageDir: "/unused",
      writableRoots: [],
      callTool: () => ask((value) => toolCallResponseSchema.parse(value)),
      requestInteraction: () =>
        ask((value) => pendingInteractionResolutionSchema.parse(value)),
      onExit: () => undefined,
    };
    const source = command.sourceProviderThreadId;
    const checkpointId = command.sourceProviderCheckpointId ?? null;
    const { threadId, cwd, dynamicTools } = command;
    const spec = {
      threadId,
      providerId: "codex" as const,
      cwd,
      providerThreadId: command.providerThreadId ?? null,
      fork: source ? { sourceProviderThreadId: source, checkpointId } : null,
      instructions,
      dynamicTools,
      env: {},
      skillDirs: [],
    };
    opening = adapter.open(spec, execution, host);
    track(opening);
  }

  async function runtime({ method, params, id, result }: Message) {
    if (method === undefined) {
      if (id !== undefined) hostRequests.shift()?.(result);
      return;
    }
    const command = commandSchema.parse(params);
    if (/^thread\/(start|resume|fork)$/.test(method)) {
      await close();
      open(command);
      return;
    }
    const session = await opening;
    if (!session || builder === null) return;
    if (method === "thread/stop") {
      if (command.intent === "interrupt") track(session.interrupt());
      else await close();
    }
    if (method !== "turn/start" && method !== "turn/steer") return;
    const { clientRequestId, input } = command;
    const options = toOptions(command.options).execution;
    const turn = { clientRequestId, input, options };
    const expectedTurnId = builder.bbTurnId(command.expectedTurnId) ?? "";
    if (method === "turn/start") track(session.startTurn(turn));
    else track(session.steer({ ...turn, expectedTurnId }));
  }

  async function client({ id, method, params, result }: Message) {
    if (method === undefined) {
      const answer = await sent(`a response to ${id}`, (m) => m.id === id);
      const same = isDeepStrictEqual(answer.result, result);
      if (!same) mismatches.push(`response ${id}`);
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
    const differs = (key: string) =>
      !isDeepStrictEqual(live[key], recorded[key]);
    const differing = keys.filter(differs);
    if (differing.length > 0) mismatches.push(`${method}: ${differing.join()}`);
  }

  const lines = readFixture(scenario, "wire.ndjson")
    .split("\n")
    .filter(Boolean);
  for (const line of lines) {
    const { from, message } = entrySchema.parse(JSON.parse(line));
    if (from === "runtime") await runtime(message);
    if (from === "client") await client(message);
    const response = message.method === undefined;
    const dropped = response && skipped.has(String(message.id));
    if (from === "server" && !dropped) {
      const id = response ? liveIds.get(String(message.id)) : message.id;
      const raw: unknown = JSON.parse(line);
      const original = z.object({ message: record }).parse(raw).message;
      server.stdout.write(`${JSON.stringify({ ...original, id })}\n`);
    }
    await settle(3);
  }
  await close();
  if (failures.length > 0) throw failures[0];
  return { events, mismatches };
}
