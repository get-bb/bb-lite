import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pendingInteractionResolutionSchema } from "@bb/domain";
import type {
  ExecutionOptions,
  ProviderSession,
  SessionSpec,
} from "@bb/runner";
import type { AcpLaunchSpec } from "../src/launch-spec.js";
import { afterEach, vi } from "vitest";
import {
  createHarness,
  FAKE_AGENT,
  text,
  type HarnessOptions,
} from "./adapter-harness.js";

export type Harness = ReturnType<typeof createHarness>;

const sessions: ProviderSession[] = [];

export function closeSessionsAfterEach() {
  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      await session.close().catch(() => undefined);
    }
  });
}

export async function openSession(
  harness: Harness,
  overrides: Partial<SessionSpec> = {},
) {
  const session = await harness.open(overrides);
  sessions.push(session);
  return session;
}

export async function started(options: HarnessOptions = {}) {
  const harness = createHarness(options);
  return { harness, session: await openSession(harness) };
}

export function agentTexts(harness: Harness) {
  return harness
    .items()
    .flatMap((item) => (item.type === "agentMessage" ? [item.text] : []));
}

export function lastCompleted(harness: Harness) {
  return harness.events.findLast((event) => event.type === "turn/completed");
}

export async function openFailure(options: HarnessOptions) {
  const harness = createHarness(options);
  return openSession(harness).then(
    () => {
      throw new Error("expected the session to fail to open");
    },
    (error: unknown) => error as Error & { code?: string },
  );
}

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

export function echoedMcpConfig(harness: Harness) {
  const prefix = "mcp-server-config:";
  const found = agentTexts(harness).find((value) => value.startsWith(prefix));
  if (found === undefined) throw new Error("no MCP server config echoed");
  return JSON.parse(found.slice(prefix.length)) as McpServerConfig[];
}

export function mcpEnv(config: McpServerConfig) {
  return Object.fromEntries(config.env.map(({ name, value }) => [name, value]));
}

interface McpResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string };
}

export function spawnMcpServer(config: McpServerConfig) {
  const child = spawn(config.command, config.args, {
    env: { ...process.env, ...mcpEnv(config) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const responses: McpResponse[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    responses.push(JSON.parse(line) as McpResponse);
  });
  let next = 0;
  const send = (message: Record<string, unknown>) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const request = (method: string, params: Record<string, unknown> = {}) => {
    next += 1;
    const id = next;
    send({ id, method, params });
    return id;
  };
  const response = (id: number) =>
    vi.waitFor(
      () => {
        const found = responses.find((message) => message.id === id);
        if (found === undefined) throw new Error(`no MCP response ${id}`);
        return found;
      },
      { timeout: 10_000, interval: 20 },
    );
  return {
    child,
    responses,
    send,
    request,
    response,
    call: async (method: string, params: Record<string, unknown> = {}) =>
      response(request(method, params)),
    stop: () => child.kill(),
  };
}

export const permissionCli = {
  full: ["--full"],
  workspaceWrite: ["--workspace"],
  insertAfterArgs: 1,
};

export function fakeLaunch(
  env: Record<string, string>,
  extra: Partial<AcpLaunchSpec> = {},
) {
  return {
    launch: {
      displayName: "Fake agent",
      command: process.execPath,
      args: [FAKE_AGENT],
      env,
      ...extra,
    },
  };
}

let requests = 0;

export function nextRequestId() {
  requests += 1;
  return `creq_port_${requests}`;
}

export function completions(harness: Harness) {
  return harness.events.filter((event) => event.type === "turn/completed")
    .length;
}

export async function waitForCompletions(harness: Harness, count: number) {
  await vi.waitFor(
    () => {
      harness.host.events.flush();
      if (completions(harness) < count) throw new Error("turn running");
    },
    { timeout: 10_000, interval: 20 },
  );
}

export async function startTurn(
  harness: Harness,
  session: ProviderSession,
  prompt: string,
  overrides: Partial<ExecutionOptions> = {},
) {
  const options = { ...harness.execution, ...overrides };
  const clientRequestId = nextRequestId();
  await session.startTurn({ clientRequestId, input: text(prompt), options });
  return clientRequestId;
}

export async function runTurn(
  harness: Harness,
  session: ProviderSession,
  prompt: string,
  overrides: Partial<ExecutionOptions> = {},
) {
  const before = completions(harness);
  await startTurn(harness, session, prompt, overrides);
  await waitForCompletions(harness, before + 1);
}

export function steer(
  harness: Harness,
  session: ProviderSession,
  prompt: string,
  overrides: Partial<ExecutionOptions> = {},
  clientRequestId = nextRequestId(),
) {
  return session.steer({
    clientRequestId,
    input: text(prompt),
    options: { ...harness.execution, ...overrides },
    expectedTurnId: harness.host.events.activeTurnId ?? "",
  });
}

export function accepted(harness: Harness) {
  return harness.events.flatMap((event) =>
    event.type === "turn/input/accepted" ? [event.clientRequestId] : [],
  );
}

export function loggedPrompts(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const value: unknown = JSON.parse(line);
      return typeof value === "string" ? value : JSON.stringify(value);
    });
}

export function answerWith(harness: Harness, decision: string) {
  const resolution = pendingInteractionResolutionSchema.parse(
    decision === "deny" ? { decision } : { decision, grantedPermissions: null },
  );
  harness.host.requestInteraction = async ({ payload }) => {
    harness.interactions.push(payload);
    return resolution;
  };
}
