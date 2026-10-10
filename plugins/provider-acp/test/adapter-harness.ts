import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pendingInteractionResolutionSchema } from "@bb/domain";
import type {
  DynamicTool,
  PendingInteractionPayload,
  PendingInteractionResolution,
  PromptInput,
  ToolCallResponse,
} from "@bb/domain";
import {
  EventBuilder,
  type ExecutionOptions,
  type ProviderSession,
  type RunnerThreadEvent,
  type SessionHost,
  type SessionSpec,
} from "@bb/runner";
import { vi } from "vitest";
import { createAcpAdapter } from "../runner/adapter.js";
import { setAcpToolProxyDirectory } from "../runner/engine.js";
import type { AcpRunnerAgent } from "../src/launch-spec.js";

export const FAKE_AGENT = fileURLToPath(
  new URL("./fixtures/fake-acp-agent.mjs", import.meta.url),
);

export interface HarnessOptions {
  env?: Record<string, string>;
  agent?: Partial<AcpRunnerAgent>;
  dynamicTools?: DynamicTool[];
  instructions?: string;
  permissionMode?: ExecutionOptions["permissionMode"];
  answer?(payload: PendingInteractionPayload): PendingInteractionResolution;
  tool?(call: { tool: string; arguments: unknown }): ToolCallResponse;
}

let threads = 0;

export function text(value: string): PromptInput[] {
  return [{ type: "text", text: value, mentions: [] }];
}

export function createHarness(options: HarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bb-acp-test-"));
  setAcpToolProxyDirectory(join(dir, "proxy"));
  threads += 1;
  const threadId = `thr_acp_${threads}`;
  const events: RunnerThreadEvent[] = [];
  const exits: { message: string; stderrTail: string }[] = [];
  const interactions: PendingInteractionPayload[] = [];
  const toolCalls: { tool: string; arguments: unknown }[] = [];
  const builder = new EventBuilder({
    emit: (event) => events.push(event),
    textFlushMs: 0,
  });
  const processEnv = Object.fromEntries(
    Object.entries(process.env).flatMap(([name, value]) =>
      value === undefined || name.startsWith("BB_") ? [] : [[name, value]],
    ),
  );
  const host: SessionHost = {
    events: builder,
    env: {},
    processEnv,
    threadStorageDir: join(dir, "storage"),
    writableRoots: [join(dir, "storage")],
    async callTool(call) {
      toolCalls.push({ tool: call.tool, arguments: call.arguments });
      const ok = [{ type: "inputText" as const, text: "tool ok" }];
      return options.tool?.(call) ?? { success: true, contentItems: ok };
    },
    async requestInteraction({ payload }) {
      interactions.push(payload);
      const allow = { decision: "allow_once" };
      const fallback = pendingInteractionResolutionSchema.parse(allow);
      return options.answer?.(payload) ?? fallback;
    },
    onExit: (info) => void exits.push(info),
  };
  const agent: AcpRunnerAgent = {
    id: "acp-fake",
    displayName: "Fake agent",
    launch: {
      displayName: "Fake agent",
      command: process.execPath,
      args: [FAKE_AGENT],
      env: options.env ?? {},
    },
    ...options.agent,
  };
  const adapter = createAcpAdapter(agent);
  const execution: ExecutionOptions = {
    model: "acp-default",
    reasoningLevel: "medium",
    serviceTier: "default",
    permissionMode: options.permissionMode ?? "full",
    permissionEscalation: "ask",
    providerOptions: {},
  };
  const spec: SessionSpec = {
    threadId,
    providerId: agent.id,
    cwd: dir,
    providerThreadId: null,
    instructions: options.instructions ?? "",
    dynamicTools: options.dynamicTools ?? [],
    env: {},
    skillDirs: [],
  };
  let requests = 0;
  const completed = () =>
    events.filter((event) => event.type === "turn/completed").length;
  const turn = async (session: ProviderSession, prompt: string) => {
    const before = completed();
    requests += 1;
    const clientRequestId = `req_${requests}`;
    const input = text(prompt);
    await session.startTurn({ clientRequestId, input, options: execution });
    await vi.waitFor(
      () => {
        builder.flush();
        if (completed() === before) throw new Error("turn still running");
      },
      { timeout: 10_000, interval: 20 },
    );
    return events;
  };
  const types = () => events.map((event) => event.type);
  const items = () =>
    events.flatMap((event) =>
      event.type === "item/completed" ? [event.item] : [],
    );
  return {
    adapter,
    agent,
    dir,
    events,
    execution,
    exits,
    host,
    interactions,
    items,
    spec,
    toolCalls,
    turn,
    types,
    open: (overrides: Partial<SessionSpec> = {}) =>
      adapter.open({ ...spec, ...overrides }, execution, host),
  };
}
