import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ProviderSession, SessionSpec } from "@bb/runner";
import { afterEach, vi } from "vitest";
import { createHarness, type HarnessOptions } from "./adapter-harness.js";

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
