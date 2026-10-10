import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toolCallResponseSchema, type DynamicTool } from "@bb/domain";
import { z } from "zod";
import { MCP_PROXY_SOURCE } from "./mcp-proxy-source.js";

export const ACP_BRIDGE_MCP_SERVER_NAME = "bb-bridge";

const ENV_HOST = "BB_ACP_DYNAMIC_TOOL_HOST";
const ENV_PORT = "BB_ACP_DYNAMIC_TOOL_PORT";
const ENV_TOKEN = "BB_ACP_DYNAMIC_TOOL_TOKEN";
const ENV_THREAD_ID = "BB_ACP_DYNAMIC_TOOL_THREAD_ID";
const ENV_TOOLS = "BB_ACP_DYNAMIC_TOOLS";

export interface AcpMcpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

interface BuildAcpMcpServerConfigArgs {
  bridgeArgs: string[];
  command: string;
  dynamicTools: readonly DynamicTool[];
  host: string;
  port: number;
  runtimeEnv: { name: string; value: string }[];
  threadId: string;
  token: string;
}

export const dynamicToolBridgeRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("initialized"),
    threadId: z.string().min(1),
    token: z.string().min(1),
    toolCount: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("toolCall"),
    arguments: z.record(z.string(), z.unknown()).default({}),
    callId: z.string().min(1),
    threadId: z.string().min(1),
    token: z.string().min(1),
    tool: z.string().min(1),
  }),
]);

export function buildAcpMcpServerConfig(
  args: BuildAcpMcpServerConfigArgs,
): AcpMcpServerConfig {
  return {
    name: ACP_BRIDGE_MCP_SERVER_NAME,
    command: args.command,
    args: args.bridgeArgs,
    env: [
      ...args.runtimeEnv,
      { name: ENV_HOST, value: args.host },
      { name: ENV_PORT, value: String(args.port) },
      { name: ENV_TOKEN, value: args.token },
      { name: ENV_THREAD_ID, value: args.threadId },
      { name: ENV_TOOLS, value: JSON.stringify(args.dynamicTools) },
    ],
  };
}

export async function ensureMcpProxyScript(directory: string): Promise<string> {
  const digest = createHash("sha256").update(MCP_PROXY_SOURCE).digest("hex");
  const path = join(directory, `bb-acp-tool-proxy-${digest.slice(0, 12)}.mjs`);
  const current = await readFile(path, "utf8").catch(() => null);
  if (current !== MCP_PROXY_SOURCE) {
    await mkdir(directory, { recursive: true });
    await writeFile(path, MCP_PROXY_SOURCE, "utf8");
  }
  return path;
}

export interface BridgeToolCallImage {
  data: string;
  mimeType: string;
}

export type BridgeToolCallContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const IMAGE_DATA_URL = /^data:(.+);base64,(.+)$/s;

export function decodeToolCallResponsePayload(result: unknown): {
  content: string;
  contentBlocks: BridgeToolCallContent[];
  images: BridgeToolCallImage[];
  isError: boolean;
} {
  const parsed = toolCallResponseSchema.safeParse(result);
  if (!parsed.success) {
    const text = "Invalid tool call response";
    const contentBlocks: BridgeToolCallContent[] = [{ type: "text", text }];
    return { content: text, contentBlocks, images: [], isError: true };
  }
  const texts: string[] = [];
  const contentBlocks: BridgeToolCallContent[] = [];
  const images: BridgeToolCallImage[] = [];
  for (const item of parsed.data.contentItems) {
    if (item.type === "inputText") {
      texts.push(item.text);
      if (item.text !== "")
        contentBlocks.push({ type: "text", text: item.text });
      continue;
    }
    const match = IMAGE_DATA_URL.exec(item.imageUrl);
    if (match === null || match[2].length === 0) {
      texts.push(item.imageUrl);
      contentBlocks.push({ type: "text", text: item.imageUrl });
      continue;
    }
    const image = { mimeType: match[1], data: match[2] };
    images.push(image);
    contentBlocks.push({ type: "image", ...image });
  }
  const isError = !parsed.data.success;
  if (contentBlocks.length === 0) {
    const text = isError ? "Tool call failed" : "OK";
    return {
      content: text,
      contentBlocks: [{ type: "text", text }],
      images,
      isError,
    };
  }
  return { content: texts.join("\n"), contentBlocks, images, isError };
}
