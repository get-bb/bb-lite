import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
  type PendingInteractionPayload,
  type PendingInteractionResolution,
  type ToolCallResponse,
} from "@bb/domain";
import { z } from "zod";
import {
  EventBuilder,
  createClaudeAdapter,
  type ClaudeAdapterOptions,
  type ClaudeQueryInput,
  type ExecutionOptions,
  type RunnerThreadEvent,
  type SessionHost,
  type SessionSpec,
} from "@bb/runner";

type QueryArgs = Parameters<NonNullable<ClaudeAdapterOptions["query"]>>[0];
type Session = Awaited<ReturnType<ClaudeHarness["open"]>>;
export type ClaudeHarness = ReturnType<typeof createClaudeHarness>;

interface PendingInteraction {
  payload: PendingInteractionPayload;
  turnId: string | null;
  resolve(resolution: PendingInteractionResolution): void;
  reject(error: Error): void;
}

const record = z.record(z.string(), z.unknown());
const optionsSchema = z.object({
  model: z.string(),
  reasoningLevel: reasoningLevelSchema,
  serviceTier: serviceTierSchema,
  permissionMode: permissionModeSchema,
  permissionEscalation: z.enum(permissionEscalationValues).nullish(),
  instructions: z.string().default(""),
  envVars: z.record(z.string(), z.string()).default({}),
  providerOptions: z
    .object({
      additionalWorkspaceWriteRoots: z.array(z.string()).optional(),
      claudeCodePermissionMode: z.string().optional(),
      memoryEnabled: z.boolean().optional(),
      providerSubagentsEnabled: z.boolean().optional(),
      workflowsEnabled: z.boolean().optional(),
    })
    .default({}),
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
  intent: z.string().optional(),
});
const permissionRequestSchema = z.object({
  tool_name: z.string(),
  input: record,
  tool_use_id: z.string(),
  permission_suggestions: z.array(z.unknown()).optional(),
  blocked_path: z.string().optional(),
  decision_reason: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
});
const entrySchema = z.object({
  from: z.enum(["runtime", "sdk", "cli", "bridge"]),
  message: z.looseObject({
    type: z.string().optional(),
    method: z.string().optional(),
    params: z.looseObject({ payload: z.unknown().optional() }).optional(),
    result: z.unknown().optional(),
    request_id: z.string().optional(),
    request: z.looseObject({ subtype: z.string() }).optional(),
    response: record.optional(),
    message: z.looseObject({ content: z.unknown().optional() }).optional(),
  }),
});
type Entry = z.infer<typeof entrySchema>["message"];

const FIXTURES = fileURLToPath(new URL("./fixtures/claude/", import.meta.url));
const SPEC: SessionSpec = {
  threadId: "thr_claude",
  providerId: "claude-code",
  cwd: "/workspace",
  providerThreadId: null,
  fork: null,
  instructions: "",
  dynamicTools: [],
  env: {},
  skillDirs: [],
};
const OPTIONS: ExecutionOptions = {
  model: "claude-opus-5[1m]",
  reasoningLevel: "medium",
  serviceTier: "default",
  permissionMode: "accept-edits",
  permissionEscalation: "ask",
  planMode: false,
  providerOptions: {},
};

export class FakeQuery {
  readonly sent: unknown[] = [];
  readonly calls: [method: string, ...args: unknown[]][] = [];
  private readonly queue: unknown[] = [];
  private wake = () => {};
  private closed = false;

  constructor(readonly args: QueryArgs) {
    if (typeof args.prompt !== "string") void this.read(args.prompt);
  }

  emit(...messages: unknown[]) {
    this.queue.push(...messages);
    this.wake();
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.queue.length > 0) yield this.queue.shift();
      else if (this.closed) return;
      else await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  close = () => {
    this.closed = true;
    this.wake();
  };
  interrupt = async () => this.note("interrupt");
  setPermissionMode = async (mode: string) => this.note("mode", mode);
  setModel = async (model?: string) => this.note("model", model);
  applyFlagSettings = async (flags: unknown) => this.note("flags", flags);
  initializationResult = () => Promise.reject(new Error("not scripted"));

  private note(...call: [string, ...unknown[]]) {
    this.calls.push(call);
    return undefined;
  }

  private async read(prompt: ClaudeQueryInput) {
    for await (const message of prompt) this.sent.push(message);
    this.close();
  }
}

export async function settle(rounds = 4) {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export function createClaudeHarness() {
  const events: RunnerThreadEvent[] = [];
  const interactions: PendingInteraction[] = [];
  const toolCalls: Parameters<SessionHost["callTool"]>[0][] = [];
  const exits: string[] = [];
  const queries: FakeQuery[] = [];
  const adapter = createClaudeAdapter({
    query: (args) => {
      queries.push(new FakeQuery(args));
      return queries[queries.length - 1] ?? new FakeQuery(args);
    },
    forkSession: async () => ({ sessionId: randomUUID() }),
  });
  const called: ToolCallResponse = {
    contentItems: [{ type: "inputText", text: "moved" }],
    success: true,
  };
  async function open(
    spec: Partial<SessionSpec> = {},
    options: Partial<ExecutionOptions> = {},
    env: Partial<Pick<SessionHost, "env" | "processEnv">> = {},
  ) {
    const emit = (event: RunnerThreadEvent) => events.push(event);
    const providerId = "claude-code";
    const builder = new EventBuilder({ providerId, emit, textFlushMs: 0 });
    const host: SessionHost = {
      events: builder,
      env: env.env ?? {},
      processEnv: env.processEnv ?? {},
      threadStorageDir: "/unused",
      writableRoots: [],
      callTool: async (call) => (toolCalls.push(call), called),
      requestInteraction: ({ payload, turnId }) =>
        new Promise((resolve, reject) =>
          interactions.push({ payload, turnId, resolve, reject }),
        ),
      onExit: (info) => exits.push(info.message),
    };
    const execution = { ...OPTIONS, ...options };
    const session = await adapter.open({ ...SPEC, ...spec }, execution, host);
    const query = queries[queries.length - 1];
    if (query === undefined) throw new Error("the adapter started no query");
    const turn = (text: string, clientRequestId = "creq_aaaaaaaaaa") => {
      const input = [{ type: "text" as const, text, mentions: [] }];
      return session.startTurn({ clientRequestId, input, options: execution });
    };
    return { session, query, builder, turn, execution };
  }
  return { adapter, events, interactions, toolCalls, exits, open };
}

export function readOriginalEvents(scenario: string) {
  const raw = readFileSync(`${FIXTURES}${scenario}.events.json`, "utf8");
  const events: unknown = JSON.parse(raw);
  return events as RunnerThreadEvent[];
}

export function normalizeIds<T>(events: T[]): T[] {
  const ids = new Map<string, string>();
  const intern = (id: string) => {
    if (!ids.has(id)) ids.set(id, `#${ids.size + 1}`);
    return ids.get(id) ?? id;
  };
  const json = JSON.stringify(events)
    .replace(/da[0-9a-f]{8}-[ti]\d+/g, intern)
    .replace(
      /("providerThreadId":")([^"]+)/g,
      (_, key: string, id: string) => `${key}${intern(id)}`,
    );
  return JSON.parse(json) as T[];
}

function toOptions(options: z.infer<typeof optionsSchema> | undefined) {
  const { instructions, envVars, permissionEscalation, ...rest } =
    optionsSchema.parse(options ?? {});
  const original = rest.providerOptions;
  const providerOptions = {
    additionalWorkspaceWriteRoots: original.additionalWorkspaceWriteRoots,
    memoryEnabled: original.memoryEnabled,
    subagentsDisabled: original.providerSubagentsEnabled === false,
    workflowsDisabled: original.workflowsEnabled === false,
  };
  const execution: ExecutionOptions = {
    ...rest,
    permissionEscalation: permissionEscalation ?? "ask",
    planMode: original.claudeCodePermissionMode === "plan",
    providerOptions,
  };
  return { execution, instructions, envVars };
}

export async function replayClaudeRecording(scenario: string) {
  const harness = createClaudeHarness();
  const mismatches: string[] = [];
  const checked: string[] = [];
  const failures: unknown[] = [];
  const decisions = new Map<string, Promise<unknown>>();
  const state: { live: Session | null } = { live: null };
  const track = (work: Promise<unknown>) =>
    void work.catch((error) => failures.push(error));
  const compare = (label: string, actual: unknown, recorded: unknown) => {
    const plain: unknown = JSON.parse(JSON.stringify(actual ?? null));
    checked.push(label);
    if (!isDeepStrictEqual(plain, recorded)) mismatches.push(label);
  };
  async function awaited<T>(label: string, read: () => T | undefined) {
    for (
      let attempt = 0;
      attempt < 200 && failures.length === 0;
      attempt += 1
    ) {
      const value = read();
      if (value !== undefined) return value;
      await settle(1);
    }
    throw failures[0] ?? new Error(`${scenario}: the adapter never ${label}`);
  }

  async function runtime({ method, params, result }: Entry) {
    if (method === undefined) {
      const resolution = pendingInteractionResolutionSchema.parse(result);
      harness.interactions.shift()?.resolve(resolution);
      return;
    }
    const command = commandSchema.parse(params);
    if (method === "thread/stop") {
      const { session, builder } = state.live ?? {};
      state.live = null;
      if (command.intent === "interrupt") await session?.interrupt();
      builder?.settle("interrupted");
      await session?.close();
      return;
    }
    const { execution, instructions, envVars } = toOptions(command.options);
    if (/^thread\/(start|resume|fork)$/.test(method)) {
      await state.live?.session.close();
      const source = command.sourceProviderThreadId;
      const checkpointId = command.sourceProviderCheckpointId ?? null;
      const { threadId, cwd, dynamicTools } = command;
      const providerThreadId = command.providerThreadId ?? null;
      const fork = source
        ? { sourceProviderThreadId: source, checkpointId }
        : null;
      const identity = { threadId, cwd, providerThreadId, fork };
      const spec = { ...identity, instructions, dynamicTools };
      state.live = await harness.open(spec, execution, { env: envVars });
      return;
    }
    if (state.live === null) return;
    const { session, builder } = state.live;
    const { clientRequestId, input } = command;
    const turn = { clientRequestId, input, options: execution };
    const expectedTurnId = builder.activeTurnId ?? "";
    if (method === "turn/start") track(session.startTurn(turn));
    if (method === "turn/steer")
      track(session.steer({ ...turn, expectedTurnId }));
  }

  async function cli(message: Entry) {
    const { live } = state;
    if (live === null) return;
    if (message.type !== "control_request") return live.query.emit(message);
    const request = permissionRequestSchema.parse(message.request);
    const canUseTool = live.query.args.options.canUseTool;
    const requestId = message.request_id ?? "";
    const decision = canUseTool?.(request.tool_name, request.input, {
      signal: new AbortController().signal,
      suggestions: request.permission_suggestions as never,
      blockedPath: request.blocked_path,
      decisionReason: request.decision_reason,
      title: request.title,
      description: request.description,
      toolUseID: request.tool_use_id,
      requestId,
    });
    decisions.set(requestId, Promise.resolve(decision));
  }

  async function sdk(message: Entry) {
    const { query } = state.live ?? {};
    if (query === undefined) return;
    if (message.type === "user") {
      const sent = await awaited("sent the prompt", () => query.sent.shift());
      const content = entrySchema.shape.message.parse(sent).message?.content;
      compare("prompt text", content, message.message?.content);
    } else if (message.type === "control_response") {
      const decision = await decisions.get(
        String(message.response?.request_id),
      );
      compare("permission result", decision, message.response?.response);
    } else if (message.request?.subtype === "set_permission_mode") {
      const call = await awaited("set the mode", () => query.calls.shift());
      compare("permission mode", call, ["mode", message.request.mode]);
    }
  }

  async function bridge(message: Entry) {
    const pending = await awaited("asked", () => harness.interactions[0]);
    const text = JSON.stringify(message.params?.payload);
    const mapped = text.replace(
      /"itemId":"([^"]+)"/,
      (_, id: string) => `"itemId":"${state.live?.builder.bbItemId(id) ?? id}"`,
    );
    compare("interaction payload", pending.payload, JSON.parse(mapped));
  }

  const wire = readFileSync(`${FIXTURES}${scenario}.wire.ndjson`, "utf8");
  for (const line of wire.split("\n").filter(Boolean)) {
    const { from, message } = entrySchema.parse(JSON.parse(line));
    await { runtime, cli, sdk, bridge }[from](message);
    await settle();
  }
  await state.live?.session.close();
  if (failures.length > 0) throw failures[0];
  return { events: harness.events, mismatches, checked };
}
