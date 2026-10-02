import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  threadEventSchema,
  type PendingInteractionPayload,
  type PendingInteractionResolution,
  type PromptInput,
} from "@bb/domain";
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
import { internIds, kept, settle } from "./kit.js";

type QueryArgs = Parameters<NonNullable<ClaudeAdapterOptions["query"]>>[0];
type CanUseTool = NonNullable<QueryArgs["options"]["canUseTool"]>;
type ToolOptions = Omit<Parameters<CanUseTool>[2], "signal" | "requestId">;
type Session = Awaited<ReturnType<ClaudeHarness["open"]>>;
type Turn = { clientRequestId: string; input: PromptInput[] };
type Asked = Parameters<SessionHost["requestInteraction"]>[0];
type Pending = Asked & { resolve(answer: PendingInteractionResolution): void };
export type ClaudeHarness = ReturnType<typeof createClaudeHarness>;

interface Step {
  open?: [SessionSpec, ExecutionOptions, { env: SessionSpec["env"] }];
  turn?: Turn & { options: ExecutionOptions };
  steer?: boolean;
  stop?: "interrupt" | "release";
  resolve?: PendingInteractionResolution;
  prompt?: string;
  decided?: { requestId: string; result: unknown };
  mode?: string;
  message?: unknown;
  permission?: [string, Record<string, unknown>, ToolOptions, string];
  interaction?: PendingInteractionPayload;
}

const FIXTURES = fileURLToPath(new URL("./fixtures/claude/", import.meta.url));
function readSteps(scenario: string) {
  const wire = readFileSync(`${FIXTURES}${scenario}.wire.ndjson`, "utf8");
  const lines = wire.split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line) as Step);
}

const [recorded] = readSteps("approval-allow");
if (recorded?.open === undefined)
  throw new Error("fixture must open a session");
export const [SPEC, OPTIONS] = recorded.open;

class FakeQuery {
  readonly sent: { message: { content: unknown } }[] = [];
  readonly calls: unknown[][] = [];
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
    while (!this.closed || this.queue.length > 0) {
      if (this.queue.length > 0) yield this.queue.shift();
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

  private note(...call: unknown[]) {
    this.calls.push(call);
    return undefined;
  }

  private async read(prompt: ClaudeQueryInput) {
    for await (const message of prompt) this.sent.push(message);
    this.close();
  }
}

export function createClaudeHarness() {
  const events: RunnerThreadEvent[] = [];
  const interactions: Pending[] = [];
  const toolCalls: Parameters<SessionHost["callTool"]>[0][] = [];
  const queries: FakeQuery[] = [];
  const adapter = createClaudeAdapter({
    query: (args) => {
      const query = new FakeQuery(args);
      queries.push(query);
      return query;
    },
  });
  async function open(
    spec: Partial<SessionSpec> = {},
    options: Partial<ExecutionOptions> = {},
    env: Partial<Pick<SessionHost, "env" | "processEnv">> = {},
  ) {
    const emit = (event: RunnerThreadEvent) => {
      threadEventSchema.parse({ ...event, threadId: SPEC.threadId });
      events.push(event);
    };
    const builder = new EventBuilder({ emit, textFlushMs: 0 });
    const moved = { type: "inputText" as const, text: "moved" };
    const host: SessionHost = {
      events: builder,
      env: env.env ?? {},
      processEnv: env.processEnv ?? {},
      threadStorageDir: "/unused",
      writableRoots: ["/storage"],
      callTool: async (call) => {
        toolCalls.push(call);
        return { contentItems: [moved], success: true };
      },
      requestInteraction: (asked) =>
        new Promise((resolve) => interactions.push({ ...asked, resolve })),
      onExit: () => undefined,
    };
    const execution = { ...OPTIONS, ...options };
    const session = await adapter.open({ ...SPEC, ...spec }, execution, host);
    const query = queries[queries.length - 1];
    if (query === undefined) throw new Error("the adapter started no query");
    const turn = (text: string, changes: Partial<ExecutionOptions> = {}) => {
      const input = [{ type: "text" as const, text, mentions: [] }];
      const request = { clientRequestId: "creq_aaaaaaaaaa", input };
      const next = { ...execution, ...changes };
      return session.startTurn({ ...request, options: next });
    };
    const decide = (tool: string, input: object, extra = {}, id = "r") => {
      const canUseTool = query.args.options.canUseTool;
      if (canUseTool === undefined) throw new Error("no permission callback");
      const signal = new AbortController().signal;
      const ids = { toolUseID: "toolu_ask", requestId: id };
      return canUseTool(tool, { ...input }, { signal, ...ids, ...extra });
    };
    return { session, query, builder, turn, decide };
  }
  return { events, interactions, toolCalls, open };
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
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = failures.length > 0 ? undefined : read();
      if (value !== undefined) return value;
      await settle(1);
    }
    throw failures[0] ?? new Error(`${scenario}: the adapter never ${label}`);
  }

  async function play(step: Step) {
    if (step.open !== undefined) {
      await state.live?.session.close();
      const [spec] = step.open;
      state.live = await harness.open(...step.open);
      const { resume } = state.live.query.args.options;
      compare("resume", resume, spec.providerThreadId);
      return;
    }
    const answer = step.resolve;
    if (answer !== undefined) harness.interactions.shift()?.resolve(answer);
    const { live } = state;
    if (live === null) return;
    const { session, builder, query } = live;
    if (step.stop !== undefined) {
      state.live = null;
      if (step.stop === "interrupt") await session.interrupt();
      builder.settle("interrupted");
      await session.close();
    }
    if (step.turn !== undefined) {
      const expectedTurnId = builder.activeTurnId ?? "";
      if (step.steer) track(session.steer({ ...step.turn, expectedTurnId }));
      else track(session.startTurn(step.turn));
    }
    if (step.message !== undefined) query.emit(step.message);
    if (step.permission !== undefined) {
      decisions.set(step.permission[3], live.decide(...step.permission));
    }
    if (step.prompt !== undefined) {
      const sent = await awaited("sent the prompt", () => query.sent.shift());
      compare("prompt", sent.message.content, step.prompt);
    }
    if (step.decided !== undefined) {
      const decision = await decisions.get(step.decided.requestId);
      compare("decision", decision, step.decided.result);
    }
    if (step.mode !== undefined) {
      const call = await awaited("set the mode", () => query.calls.shift());
      compare("mode", call, ["mode", step.mode]);
    }
    if (step.interaction !== undefined) {
      const pending = await awaited("asked", () => harness.interactions[0]);
      const mapped = JSON.stringify(step.interaction).replace(
        /"itemId":"([^"]+)"/,
        (_, id: string) => `"itemId":"${builder.bbItemId(id) ?? id}"`,
      );
      compare("interaction", pending.payload, JSON.parse(mapped));
    }
  }

  for (const step of readSteps(scenario)) {
    await play(step);
    await settle();
  }
  await state.live?.session.close();
  if (failures.length > 0) throw failures[0];
  const expected = readFileSync(`${FIXTURES}${scenario}.events.json`, "utf8");
  const recorded = JSON.parse(expected) as { type: string }[];
  const original = internIds<unknown>(kept(recorded), true);
  const events = internIds<unknown>(harness.events, true);
  return { events, original, mismatches, checked };
}
