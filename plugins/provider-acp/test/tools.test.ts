import { createConnection } from "node:net";
import type { ToolCallResponse } from "@bb/domain";
import type { DynamicTool } from "@bb/domain";
import { expect, it, vi } from "vitest";
import { ACP_TOOL_PROXY_SERVER_NAME } from "../runner/agent/tool-proxy-mcp.js";
import {
  closeSessionsAfterEach,
  echoedMcpConfig,
  mcpEnv,
  spawnMcpServer,
  started,
  type Harness,
} from "./sessions-helpers.js";

closeSessionsAfterEach();

const environmentTool: DynamicTool = {
  name: "update_environment_directory",
  description: "Move this thread to another environment directory.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

async function proxyFor(harness: Harness) {
  const [config, ...rest] = echoedMcpConfig(harness);
  expect(rest).toEqual([]);
  if (config === undefined) throw new Error("no MCP server config");
  expect(config.name).toBe(ACP_TOOL_PROXY_SERVER_NAME);
  const server = spawnMcpServer(config);
  const init = await server.call("initialize", {
    protocolVersion: "2024-11-05",
  });
  expect(init.result).toMatchObject({ capabilities: { tools: {} } });
  return { config, server };
}

it("forwards ACP dynamic tool calls through the runtime tool-call contract", async () => {
  const updated = "environment directory updated";
  const { harness, session } = await started({
    dynamicTools: [environmentTool],
    tool: () => ({
      success: true,
      contentItems: [{ type: "inputText", text: updated }],
    }),
  });
  await harness.turn(session, "echo-mcp-server-config");
  const { server } = await proxyFor(harness);
  try {
    const listed = await server.call("tools/list");
    expect(listed.result).toEqual({
      tools: [
        {
          name: environmentTool.name,
          description: environmentTool.description,
          inputSchema: environmentTool.inputSchema,
        },
      ],
    });
    const called = await server.call("tools/call", {
      name: "update_environment_directory",
      arguments: { path: "/tmp/next-worktree" },
    });
    expect(harness.toolCalls).toEqual([
      {
        tool: "update_environment_directory",
        arguments: { path: "/tmp/next-worktree" },
      },
    ]);
    expect(called.result).toEqual({
      content: [{ type: "text", text: updated }],
    });
  } finally {
    server.stop();
  }
});

it.each(["socket-close", "provider-exit", "turn-end"])(
  "cancels the runtime tool request after %s",
  async (kind) => {
    const { harness, session } = await started({
      dynamicTools: [environmentTool],
    });
    await harness.turn(session, "echo-mcp-server-config");
    const { server } = await proxyFor(harness);
    harness.host.callTool = (call) => {
      harness.toolCalls.push({ tool: call.tool, arguments: call.arguments });
      return new Promise<ToolCallResponse>(() => undefined);
    };
    try {
      const id = server.request("tools/call", {
        name: "update_environment_directory",
        arguments: {},
      });
      await vi.waitFor(() => expect(harness.toolCalls).toHaveLength(1));
      if (kind === "socket-close") {
        server.send({
          method: "notifications/cancelled",
          params: { requestId: id },
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(server.responses.some((message) => message.id === id)).toBe(
          false,
        );
      } else {
        const prompt = kind === "provider-exit" ? "die" : "done";
        const { clientRequestId, input } = {
          clientRequestId: "req_end",
          input: [{ type: "text" as const, text: prompt, mentions: [] }],
        };
        const options = harness.execution;
        void session
          .startTurn({ clientRequestId, input, options })
          .catch(() => undefined);
        expect(await server.response(id)).toMatchObject({
          result: {
            isError: true,
            content: [
              { type: "text", text: "ACP dynamic tool call cancelled" },
            ],
          },
        });
      }
    } finally {
      server.stop();
    }
  },
);

it("keeps the dynamic-tool TCP server alive after a client reset on initialize", async () => {
  const { harness, session } = await started({
    dynamicTools: [environmentTool],
  });
  await harness.turn(session, "echo-mcp-server-config");
  const [config] = echoedMcpConfig(harness);
  if (config === undefined) throw new Error("no MCP server config");
  const env = mcpEnv(config);
  const host = env.BB_ACP_DYNAMIC_TOOL_HOST;
  const port = Number(env.BB_ACP_DYNAMIC_TOOL_PORT);
  await new Promise<void>((resolve) => {
    const socket = createConnection({ host, port });
    socket.on("connect", () => {
      const report = {
        kind: "initialized",
        threadId: env.BB_ACP_DYNAMIC_TOOL_THREAD_ID,
        token: env.BB_ACP_DYNAMIC_TOOL_TOKEN,
        toolCount: 1,
      };
      socket.write(`${JSON.stringify(report)}\n`);
      socket.resetAndDestroy();
    });
    socket.on("error", () => resolve());
    socket.on("close", () => resolve());
  });
  const { server } = await proxyFor(harness);
  try {
    const called = await server.call("tools/call", {
      name: "update_environment_directory",
      arguments: { path: "/tmp/next-worktree" },
    });
    expect(called.result).toEqual({
      content: [{ type: "text", text: "tool ok" }],
    });
  } finally {
    server.stop();
  }
});
