import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { sessions } from "@bb/plugin";
import {
  threadEventSchema,
  type DynamicTool,
  type PendingInteractionPayload,
} from "@bb/domain";
import {
  EventBuilder,
  type ExecutionOptions,
  type SessionSpec,
  type RunnerThreadEvent,
  type SessionHost,
} from "@bb/runner";
import { expect, it } from "vitest";
import { z } from "zod";
import { createTestServer } from "../../../apps/server/test/helpers.js";
import { settle } from "../../../packages/runner/test/kit.js";
import { createPiAdapter } from "../runner/pi.js";
import type { PiLaunch } from "../runner/pi-rpc.js";

type Event = Record<string, unknown>;
const commandSchema = z.looseObject({ id: z.string(), type: z.string() });

function fixture(name: string): Event {
  const url = new URL(`./fixtures/${name}.json`, import.meta.url);
  return z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(readFileSync(url, "utf8")));
}

const TURN = [
  fixture("agent-start"),
  fixture("message-update-delta"),
  fixture("tool-execution-start-bash"),
  fixture("tool-execution-end-bash"),
  fixture("agent-end-with-message"),
];

class FakePi extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  channel = { input: new PassThrough(), output: new PassThrough() };
  received: z.infer<typeof commandSchema>[] = [];
  fromExtension: Event[] = [];
  leaves = 0;

  constructor(
    readonly launch: PiLaunch,
    script: (pi: FakePi, command: z.infer<typeof commandSchema>) => void,
  ) {
    super();
    setImmediate(() => this.extension({ kind: "ready" }));
    this.channel.output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const message = z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(line));
        this.fromExtension.push(message);
        script(this, { id: "", type: `channel:${String(message.kind)}` });
      }
    });
    let buffer = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const command = commandSchema.parse(JSON.parse(line));
        this.received.push(command);
        script(this, command);
      }
    });
  }

  send(message: Event) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
    if (message.type !== "agent_end") return;
    this.leaves += 1;
    this.extension({ kind: "agent-end-leaf", leafId: `leaf-${this.leaves}` });
  }

  extension(message: Event) {
    this.channel.input.write(`${JSON.stringify(message)}\n`);
  }

  reply(id: string, data: unknown = {}) {
    this.send({ type: "response", id, success: true, data });
  }

  kill() {
    this.emit("exit", null);
    return true;
  }
}

const options: ExecutionOptions = {
  model: "anthropic/claude-sonnet-4-6",
  reasoningLevel: "medium",
  serviceTier: "default",
  permissionMode: "full",
  permissionEscalation: "ask",
  providerOptions: {},
};

async function openSession(
  script: (pi: FakePi, command: z.infer<typeof commandSchema>) => void,
  overrides: Partial<SessionHost> = {},
  dynamicTools: DynamicTool[] = [],
  version = "0.84.1",
  extra: Partial<SessionSpec> = {},
) {
  const events: RunnerThreadEvent[] = [];
  const children: FakePi[] = [];
  const sessionDir = mkdtempSync(join(tmpdir(), "bb-pi-"));
  const adapter = createPiAdapter({
    env: { BB_PI_BRIDGE_SESSION_DIR: sessionDir },
    version: async () => version,
    spawn: (launch) => {
      const child = new FakePi(launch, script);
      children.push(child);
      return child;
    },
  });
  const emit = (event: RunnerThreadEvent) => events.push(event);
  const host: SessionHost = {
    events: new EventBuilder({ emit, textFlushMs: 0 }),
    env: {},
    processEnv: {},
    threadStorageDir: sessionDir,
    writableRoots: [],
    callTool: () => Promise.reject(new Error("unused")),
    requestInteraction: () => Promise.reject(new Error("unused")),
    onExit: () => undefined,
    ...overrides,
  };
  const spec = {
    threadId: "thr_pi",
    providerId: "pi",
    cwd: "/Users/developer/project",
    providerThreadId: null,
    instructions: "Be brief.",
    dynamicTools,
    env: {},
    skillDirs: [],
    ...extra,
  };
  const session = await adapter.open(spec, options, host);
  return { session, events, children, adapter, sessionDir };
}

function types(events: RunnerThreadEvent[]) {
  for (const event of events) {
    threadEventSchema.parse({ ...event, threadId: "thr_pi" });
  }
  return events.map((event) =>
    "item" in event ? `${event.type}:${event.item.type}` : event.type,
  );
}

it("runs a turn against a scripted Pi process", async () => {
  const { session, events, children } = await openSession((pi, command) => {
    pi.reply(command.id);
    if (command.type === "prompt") for (const event of TURN) pi.send(event);
  });
  const [pi] = children;
  expect(pi?.launch.args).toEqual(
    expect.arrayContaining(["--mode", "rpc", "--provider", "anthropic"]),
  );
  await session.startTurn({
    clientRequestId: "creq_2345678abc",
    input: [{ type: "text", text: "Fix the database config", mentions: [] }],
    options,
  });
  await settle(8);
  expect(pi?.received.map((c) => [c.type, c.message])).toEqual([
    ["get_state", undefined],
    ["prompt", "Fix the database config"],
    ["get_session_stats", undefined],
  ]);
  expect(types(events)).toEqual([
    "thread/identity",
    "turn/started",
    "turn/input/accepted",
    "item/started:agentMessage",
    "item/agentMessage/delta",
    "item/started:commandExecution",
    "item/completed:commandExecution",
    "item/completed:agentMessage",
    "thread/tokenUsage/updated",
    "turn/completed",
  ]);
  const command = events.find(
    (e) => e.type === "item/completed" && e.item.type === "commandExecution",
  );
  expect(command).toMatchObject({
    item: {
      command: "git status --short",
      exitCode: 0,
      aggregatedOutput: expect.stringContaining("database.ts"),
    },
  });
  const message = events.find(
    (e) => e.type === "item/completed" && e.item.type === "agentMessage",
  );
  expect(message).toMatchObject({
    item: { text: expect.stringContaining("new database connection") },
  });
  expect(events.at(-1)).toMatchObject({ status: "completed" });
});

function assistantEnd(text: string) {
  const content = [{ type: "text", text }];
  return { type: "message_end", message: { role: "assistant", content } };
}

it("keeps each assistant message of a turn", async () => {
  const final = "I've updated the configuration file";
  const delta = { type: "text_delta", contentIndex: 0, delta: "I've" };
  const script = [
    fixture("agent-start"),
    fixture("message-update-delta"),
    assistantEnd("Let me check the current"),
    fixture("tool-execution-start-bash"),
    fixture("tool-execution-end-bash"),
    { type: "message_update", assistantMessageEvent: delta },
    assistantEnd(final),
    fixture("agent-end-with-message"),
  ];
  const { session, events } = await openSession((pi, command) => {
    pi.reply(command.id);
    if (command.type === "prompt") for (const event of script) pi.send(event);
  });
  await session.startTurn({
    clientRequestId: "creq_2345678abc",
    input: [{ type: "text", text: "Fix it", mentions: [] }],
    options,
  });
  await settle(8);
  const texts = events.flatMap((e) =>
    e.type === "item/completed" && e.item.type === "agentMessage"
      ? [e.item.text]
      : [],
  );
  expect(texts).toEqual(["Let me check the current", final]);
  expect(events.at(-1)).toMatchObject({ status: "completed" });
});

it("interrupts a running turn", async () => {
  const { session, events } = await openSession((pi, command) => {
    pi.reply(command.id);
    if (command.type === "prompt") pi.send(fixture("agent-start"));
    if (command.type === "abort") {
      pi.send({ type: "agent_end", messages: [] });
    }
  });
  await session.startTurn({
    clientRequestId: "creq_2345678abc",
    input: [{ type: "text", text: "Long task", mentions: [] }],
    options,
  });
  await settle(8);
  await session.interrupt();
  await settle(8);
  expect(events.at(-1)).toMatchObject({
    type: "turn/completed",
    status: "interrupted",
  });
});

it("lists Pi's models with the aliases first", async () => {
  const { adapter } = await openSession((pi, command) => {
    const models = [
      { id: "claude-sonnet-4-6", provider: "anthropic", reasoning: true },
      { id: "claude-3-5-sonnet-20241022", provider: "anthropic" },
      { id: "gpt-5", provider: "openai", reasoning: true },
    ];
    const state = { model: { provider: "openai", id: "gpt-5" } };
    if (command.type === "get_state") pi.reply(command.id, state);
    else pi.reply(command.id, { models });
  });
  const listed = await adapter.listModels("/tmp");
  expect(listed.models.map((m) => [m.id, m.isDefault])).toEqual([
    ["anthropic/claude-sonnet-4-6", false],
    ["openai/gpt-5", true],
  ]);
  expect(listed.models[0]?.defaultReasoningEffort).toBe("medium");
  expect(listed.selectedOnlyModels.map((m) => m.id)).toEqual([
    "anthropic/claude-3-5-sonnet-20241022",
  ]);
});

it("declares the Pi provider", async () => {
  const server = await createTestServer();
  const providers = await server.ctx.kernel.call(sessions.providers, {});
  expect(providers.find((p) => p.id === "pi")).toMatchObject({
    displayName: "Pi",
  });
});

const prompt = (text: string) => ({
  clientRequestId: "creq_2345678abc",
  input: [{ type: "text" as const, text, mentions: [] }],
  options,
});

it("answers Pi's calls to bb's tools through the runner", async () => {
  const calls: unknown[] = [];
  const tool = {
    name: "bb_echo",
    description: "Echo text",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  };
  const start = {
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "bb_echo",
    args: { text: "hi" },
  };
  const { session, events, children } = await openSession(
    (pi, command) => {
      if (command.id) pi.reply(command.id);
      if (command.type === "prompt") {
        pi.send(fixture("agent-start"));
        pi.send(start);
        const { toolCallId, toolName, args } = start;
        const call = { toolCallId, toolName, arguments: args };
        pi.extension({ ...call, kind: "tool-call", id: "tc-1" });
      }
      if (command.type === "channel:tool-result") {
        const result = { content: [{ type: "text", text: "echo: hi" }] };
        pi.send({ ...start, type: "tool_execution_end", result });
        pi.send({ type: "agent_end", messages: [] });
      }
    },
    {
      callTool: async (call) => {
        calls.push(call);
        const text = "echo: hi";
        return { success: true, contentItems: [{ type: "inputText", text }] };
      },
    },
    [tool],
  );
  const [pi] = children;
  const args = pi?.launch.args ?? [];
  const extension = args[args.indexOf("--extension") + 1] ?? "";
  expect(readFileSync(extension, "utf8")).toContain("registerTool");
  const toolsFile = pi?.launch.env.PI_BB_TOOLS_FILE ?? "";
  expect(JSON.parse(readFileSync(toolsFile, "utf8"))).toEqual([tool]);
  await session.startTurn(prompt("Echo hi"));
  await settle(12);
  expect(calls).toEqual([
    expect.objectContaining({
      tool: "bb_echo",
      arguments: { text: "hi" },
      turnId: expect.any(String),
    }),
  ]);
  expect(pi?.fromExtension).toEqual([
    {
      kind: "tool-result",
      id: "tc-1",
      content: [{ type: "text", text: "echo: hi" }],
      isError: false,
    },
  ]);
  expect(events.at(-1)).toMatchObject({ status: "completed" });
});

it("turns Pi's extension dialogs into questions for the user", async () => {
  const asked: PendingInteractionPayload[] = [];
  const { session, children } = await openSession(
    (pi, command) => {
      if (command.id) pi.reply(command.id);
      if (command.type !== "prompt") return;
      pi.send(fixture("agent-start"));
      pi.send({ type: "extension_ui_request", id: "n1", method: "notify" });
      pi.send({
        type: "extension_ui_request",
        id: "ui-1",
        method: "select",
        title: "Pick a branch",
        options: ["main", "dev"],
      });
    },
    {
      requestInteraction: async ({ payload }) => {
        asked.push(payload);
        return {
          kind: "user_answer",
          answers: { answer: { selected: ["dev"] } },
        };
      },
    },
  );
  await session.startTurn(prompt("Deploy"));
  await settle(12);
  expect(asked).toEqual([
    expect.objectContaining({
      kind: "user_question",
      questions: [
        expect.objectContaining({
          prompt: "Pick a branch",
          options: [
            { value: "main", label: "main" },
            { value: "dev", label: "dev" },
          ],
        }),
      ],
    }),
  ]);
  const responses = children[0]?.received.filter(
    (c) => c.type === "extension_ui_response",
  );
  expect(responses).toEqual([
    { type: "extension_ui_response", id: "ui-1", value: "dev" },
  ]);
});

it("streams shell output, compacts and reports the context window", async () => {
  const bash = {
    toolCallId: "call_sh",
    toolName: "bash",
    args: { command: "make" },
  };
  const partial = (text: string) => ({
    ...bash,
    type: "tool_execution_update",
    partialResult: { content: [{ type: "text", text }] },
  });
  const done = { content: [{ type: "text", text: "a\nb\n" }] };
  const stats = { contextUsage: { tokens: 1200, contextWindow: 200000 } };
  const { session, events } = await openSession((pi, command) => {
    if (command.type === "get_session_stats") pi.reply(command.id, stats);
    else if (command.id) pi.reply(command.id);
    if (command.type !== "prompt") return;
    pi.send(fixture("agent-start"));
    pi.send({ ...bash, type: "tool_execution_start" });
    pi.send(partial("a\n"));
    pi.send(partial("a\nb\n"));
    pi.send({ ...bash, type: "tool_execution_end", result: done });
    pi.send({ type: "agent_end", messages: [] });
    pi.send({ type: "compaction_start", reason: "threshold" });
    pi.send({ type: "compaction_end", reason: "threshold", aborted: false });
  });
  await session.startTurn(prompt("Build"));
  await settle(12);
  const deltas = events.flatMap((e) =>
    e.type === "item/commandExecution/outputDelta" ? [e.delta] : [],
  );
  expect(deltas).toEqual(["a\n", "b\n"]);
  const kinds = types(events);
  expect(kinds).toEqual(
    expect.arrayContaining([
      "item/completed:contextCompaction",
      "thread/compacted",
      "thread/contextWindowUsage/updated",
    ]),
  );
  expect(
    events.find((e) => e.type === "thread/contextWindowUsage/updated"),
  ).toMatchObject({
    contextWindowUsage: { usedTokens: 1200, modelContextWindow: 200000 },
  });
});

it("sends attached images and a selected skill to Pi", async () => {
  const { session, children, sessionDir } = await openSession((pi, c) =>
    pi.reply(c.id),
  );
  const png = join(sessionDir, "shot.png");
  writeFileSync(png, Buffer.from([1, 2, 3]));
  const mention = {
    start: 0,
    end: 7,
    resource: {
      kind: "command" as const,
      source: "skill" as const,
      trigger: "$" as const,
      name: "review",
    },
  };
  await session.startTurn({
    clientRequestId: "creq_2345678abc",
    input: [
      { type: "text", text: "$review the diff", mentions: [mention] },
      { type: "localImage", path: png },
      { type: "image", url: "data:image/gif;base64,R0lG" },
    ],
    options,
  });
  await settle(8);
  const sent = children[0]?.received.find((c) => c.type === "prompt");
  expect(sent).toMatchObject({
    message: "/skill:review the diff",
    images: [
      { type: "image", mimeType: "image/png", data: "AQID" },
      { type: "image", mimeType: "image/gif", data: "R0lG" },
    ],
  });
});

it("shows image reads and waits for the checkpoint leaf", async () => {
  const read = { toolCallId: "call_img", toolName: "read" };
  const { session, events } = await openSession((pi, command) => {
    pi.reply(command.id);
    if (command.type !== "prompt") return;
    pi.send({ type: "agent_start" });
    pi.send({ type: "tool_execution_start", ...read, args: { path: "a.png" } });
    pi.send({
      type: "tool_execution_end",
      ...read,
      result: { content: [{ type: "image", data: "AQID" }] },
    });
    pi.send({ type: "agent_end", messages: [] });
  });
  await session.startTurn(prompt("Look at a.png"));
  await settle(8);
  const items = events.flatMap((e) =>
    e.type === "item/started" || e.type === "item/completed" ? [e] : [],
  );
  expect(items).toMatchObject([
    {
      type: "item/completed",
      item: { type: "imageView", path: "/Users/developer/project/a.png" },
    },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: "turn/completed",
    providerCheckpointId: "leaf-1",
  });
});

it("refuses a Pi older than the supported minimum", async () => {
  await expect(
    openSession((pi, command) => pi.reply(command.id), {}, [], "0.83.9"),
  ).rejects.toThrow(/older than the supported minimum 0.84.0/);
});

async function failPrompts(error: string, failures: number) {
  let left = failures;
  const opened = await openSession((pi, command) => {
    if (command.type !== "prompt" || left === 0) return pi.reply(command.id);
    left -= 1;
    pi.send({ type: "response", id: command.id, success: false, error });
  });
  await opened.session.startTurn(prompt("Hello"));
  await settle(8);
  const prompts = opened.children[0]?.received.filter(
    (c) => c.type === "prompt",
  );
  const errors = opened.events.filter((e) => e.type === "provider/error");
  return { prompts, errors };
}

it("retries a prompt while Pi has not loaded its API key yet", async () => {
  const missingKey = "No API key found for anthropic";
  const loaded = await failPrompts(missingKey, 2);
  expect(loaded.prompts).toHaveLength(3);
  expect(new Set(loaded.prompts?.map((c) => c.message))).toEqual(
    new Set(["Hello"]),
  );
  expect(loaded.errors).toEqual([]);

  const other = await failPrompts("Model not found", 1);
  expect(other.prompts).toHaveLength(1);
  expect(other.errors).toMatchObject([
    { message: expect.stringContaining("Model not found") },
  ]);

  const never = await failPrompts(missingKey, Number.POSITIVE_INFINITY);
  expect(never.prompts).toHaveLength(9);
  expect(never.errors).toMatchObject([
    { message: expect.stringContaining(missingKey) },
  ]);
}, 10_000);

it("compacts on request and closes the turn when Pi finishes", async () => {
  const { session, events, children } = await openSession(
    (pi, command) => {
      if (command.type === "compact") {
        pi.send({ type: "compaction_start", reason: "manual" });
        pi.send({ type: "compaction_end", reason: "manual", aborted: false });
      }
      if (command.id) pi.reply(command.id);
    },
    {},
    [],
    "0.84.1",
    { instructionMode: "replace" },
  );
  expect(children[0]?.launch.args).toContain("--system-prompt");
  await session.compact?.();
  await settle(12);
  const kinds = types(events);
  expect(kinds).toContain("thread/compacted");
  expect(events.at(-1)).toMatchObject({
    type: "turn/completed",
    status: "completed",
  });
});

it("reports the minimum version and the fix in its status", async () => {
  const { adapter } = await openSession((pi, c) => pi.reply(c.id));
  expect(await adapter.status()).toMatchObject({
    minimumVersion: "0.84.0",
    versionUnsupported: false,
  });
  const old = createPiAdapter({ version: async () => "0.83.0" });
  expect(await old.status()).toMatchObject({
    versionUnsupported: true,
    installAction: { kind: "update" },
  });
  const missing = createPiAdapter({
    version: () => Promise.reject(new Error("ENOENT")),
  });
  expect(await missing.status()).toMatchObject({
    installed: false,
    installAction: { kind: "install" },
  });
});
