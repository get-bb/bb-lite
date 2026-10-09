import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { sessions } from "@bb/plugin";
import { threadEventSchema } from "@bb/domain";
import {
  EventBuilder,
  type ExecutionOptions,
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
  received: z.infer<typeof commandSchema>[] = [];

  constructor(
    readonly launch: PiLaunch,
    script: (pi: FakePi, command: z.infer<typeof commandSchema>) => void,
  ) {
    super();
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
) {
  const events: RunnerThreadEvent[] = [];
  const children: FakePi[] = [];
  const sessionDir = mkdtempSync(join(tmpdir(), "bb-pi-"));
  const adapter = createPiAdapter({
    env: { BB_PI_BRIDGE_SESSION_DIR: sessionDir },
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
  };
  const spec = {
    threadId: "thr_pi",
    providerId: "pi",
    cwd: "/Users/developer/project",
    providerThreadId: null,
    instructions: "Be brief.",
    dynamicTools: [],
    env: {},
    skillDirs: [],
  };
  const session = await adapter.open(spec, options, host);
  return { session, events, children, adapter };
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
    ];
    pi.reply(
      command.id,
      command.type === "get_available_models" ? { models } : {},
    );
  });
  const listed = await adapter.listModels("/tmp");
  expect(listed.models.map((m) => [m.id, m.isDefault])).toEqual([
    ["anthropic/claude-sonnet-4-6", true],
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
