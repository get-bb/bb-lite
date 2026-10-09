import { contract, event, op } from "@bb/plugin";
import { z } from "zod";

export const PREVIEW_DIRECTIVE_ID = "browser-preview";
export const MAX_SCRIPT_CHARS = 128_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_TIMEOUT_MS = 30_000;

export const previewDirective = (sessionId: string) =>
  `::${PREVIEW_DIRECTIVE_ID}{session="${sessionId}"}`;

const id = z.string().min(1).max(160);
const sessionId = z.string().uuid();
const script = z.string().min(1).max(MAX_SCRIPT_CHARS);
const timeoutMs = z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS);

export const sessionSchema = z
  .object({
    id: sessionId,
    threadId: id,
    hostId: id,
    backend: z.enum(["desktop", "local"]),
    state: z.enum(["ready", "stopped", "closed"]),
    createdAt: z.number().int(),
    expiresAt: z.number().int(),
  })
  .strict();
export type Session = z.infer<typeof sessionSchema>;

export const selectionSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("local"), hostId: id }).strict(),
  z
    .object({
      backend: z.literal("desktop"),
      hostId: id,
      instanceId: id,
      tabId: id.optional(),
    })
    .strict(),
]);
export type Selection = z.infer<typeof selectionSchema>;

export const imageSchema = z
  .object({
    path: z.string().min(1),
    mimeType: z.literal("image/jpeg"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

export const outputSchema = z
  .object({
    text: z.string().max(160_000),
    images: z.array(imageSchema).max(4),
    exitCode: z.number().int(),
  })
  .strict();
export type RunOutput = z.infer<typeof outputSchema>;

export const previewSizeSchema = z.enum(["thumbnail", "full"]);
export type PreviewSize = z.infer<typeof previewSizeSchema>;

export const previewFrameSchema = z
  .object({
    sequence: z.number().int().positive(),
    mimeType: z.literal("image/jpeg"),
    data: z.string().min(1).max(700_000),
    width: z.number().positive(),
    height: z.number().positive(),
    url: z.string().max(2_000),
    title: z.string().max(300),
  })
  .strict();
export type PreviewFrame = z.infer<typeof previewFrameSchema>;

const owned = z.object({ threadId: id, sessionId }).strict();
const hostSession = z.object({ sessionId }).strict();

export const runtimeStateSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      version: z.string(),
      source: z.enum(["release", "developer-artifact"]),
    })
    .strict(),
  z.object({ status: z.literal("installing"), detail: z.string() }).strict(),
]);
export type RuntimeState = z.infer<typeof runtimeStateSchema>;

export const browserAutomation = contract("browser-automation", {
  open: op({
    input: z.object({ threadId: id, selection: selectionSchema }).strict(),
    output: sessionSchema.extend({ previewDirective: z.string().optional() }),
    kind: "write",
  }),
  list: op({
    input: z.object({ threadId: id }).strict(),
    output: z.array(sessionSchema).max(64),
  }),
  run: op({
    input: owned.extend({
      script,
      timeoutMs: timeoutMs.default(DEFAULT_TIMEOUT_MS),
    }),
    output: outputSchema,
    kind: "write",
  }),
  pages: op({ input: owned, output: outputSchema }),
  screenshot: op({
    input: owned.extend({ page: z.string().min(1).max(120).default("main") }),
    output: outputSchema,
    kind: "write",
  }),
  preview: op({
    input: owned.extend({
      afterSequence: z.number().int().nonnegative().default(0),
      size: previewSizeSchema.default("thumbnail"),
    }),
    output: z
      .object({ session: sessionSchema, frame: previewFrameSchema.nullable() })
      .strict(),
  }),
  stop: op({ input: owned, output: sessionSchema, kind: "write" }),
  close: op({ input: owned, output: sessionSchema, kind: "write" }),

  hostPrepare: op({
    input: z.object({}).strict(),
    output: runtimeStateSchema,
    internal: true,
  }),
  hostOpen: op({
    input: hostSession.extend({
      expiresAt: z.number().int(),
      idleTimeoutMs: z.number().int().positive(),
    }),
    output: z.null(),
    internal: true,
  }),
  hostRun: op({
    input: hostSession.extend({ script, timeoutMs }),
    output: outputSchema,
    internal: true,
  }),
  hostPreview: op({
    input: hostSession.extend({ size: previewSizeSchema }),
    output: z.null(),
    internal: true,
  }),
  hostClose: op({ input: hostSession, output: z.null(), internal: true }),
  previewFrame: event(
    z.object({ sessionId, size: previewSizeSchema, frame: previewFrameSchema }),
  ),
});
