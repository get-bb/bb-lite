import { extname } from "node:path";
import type { ThreadEventItemPresentation } from "@bb/domain";
import { labels, presentationTitle as runnerTitle } from "@bb/runner";
import { z } from "zod";

export { agentProcessEnv, execPortableFile } from "./process.js";
export {
  decodeToolCallResponsePayload,
  type BridgeToolCallContent,
  type BridgeToolCallImage,
} from "./bridge/tool-proxy-mcp.js";

export type DeltaPresentation = ThreadEventItemPresentation;

export type JsonRpcObject = Record<string, unknown>;

export interface JsonRpcMessage extends JsonRpcObject {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
}

export type ProviderRuntimeEvent = JsonRpcObject;

export interface StringRecord {
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is StringRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getStringProperty(
  value: StringRecord,
  key: string,
): string | undefined {
  const next = value[key];
  return typeof next === "string" ? next : undefined;
}

export function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export const presentationTitle = runnerTitle;

export const COMPACTION_PRESENTATION: DeltaPresentation = labels.compaction;

export function planStepsPresentation(
  steps: readonly { step: string; status?: string }[],
): DeltaPresentation {
  const active = steps.find((step) => step.status === "active");
  return { ...labels.planSteps(active?.step), suppress: true };
}

const recordSchema = z.record(z.string(), z.unknown());

export const jsonRpcEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.string(),
    params: recordSchema.optional(),
  })
  .passthrough();

export const errorEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.literal("error"),
    params: z
      .object({ message: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function mimeTypeFromExtension(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "image/png";
  }
}
