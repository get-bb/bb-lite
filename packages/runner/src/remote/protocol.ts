import { z } from "zod";
import {
  RUNNER_ERROR_CODES,
  RunnerError,
  type RunnerEvent,
  type SessionApi,
} from "../types.js";

export const PING_INTERVAL_MS = 5_000;
export const LEASE_MS = 30_000;
export const MAX_FRAME_BYTES = 768 * 1024;
export const REPLACED_CLOSE_CODE = 4001;
export const OUTDATED_CLOSE_CODE = 4002;
const PART_CHARS = 256 * 1024;
const MAX_ASSEMBLED_CHARS = 64 * 1024 * 1024;
const MAX_TIMER_MS = 2_147_483_647;
const QUICK_MS = 15_000;
const STANDARD_MS = 60_000;
const LONG_MS = 10 * 60_000;

const REQUEST_TIMEOUT_MS = {
  describe: QUICK_MS,
  snapshot: QUICK_MS,
  ackEvents: QUICK_MS,
  listProviders: STANDARD_MS,
  listModels: STANDARD_MS,
  submitTurn: LONG_MS,
  interruptTurn: STANDARD_MS,
  releaseSession: STANDARD_MS,
  resolveInteraction: QUICK_MS,
  resolveToolCall: QUICK_MS,
  renameSession: QUICK_MS,
  deleteThreadStorage: STANDARD_MS,
  loadPlugins: STANDARD_MS,
  callOp: LONG_MS,
  cancelOp: QUICK_MS,
} as const satisfies Record<keyof SessionApi, number>;

export type RunnerMethod = keyof SessionApi;
export const RUNNER_METHODS =
  Object.keys(REQUEST_TIMEOUT_MS).filter(isRunnerMethod);

export function isRunnerMethod(name: string): name is RunnerMethod {
  return Object.hasOwn(REQUEST_TIMEOUT_MS, name);
}

const ownBudgetSchema = z.object({ timeoutMs: z.number().nonnegative() });

export function requestTimeoutMs(method: RunnerMethod, params: unknown) {
  const own = ownBudgetSchema.safeParse(params);
  const budget =
    method === "callOp" && own.success
      ? own.data.timeoutMs
      : REQUEST_TIMEOUT_MS[method];
  return Math.min(budget, MAX_TIMER_MS);
}

const seqSchema = z.number().int().nonnegative();
const errorSchema = z.object({
  code: z.enum(RUNNER_ERROR_CODES).catch("failed"),
  message: z.string(),
  retryable: z.boolean().default(false),
});
const eventEnvelopeSchema = z
  .looseObject({ lane: z.enum(["reliable", "live"]), kind: z.string() })
  .and(z.object({ lane: z.literal("live") }).or(z.object({ seq: seqSchema })));
const eventSchema = z.custom<RunnerEvent>(
  (value) => eventEnvelopeSchema.safeParse(value).success,
);
const helloSchema = z.object({
  t: z.literal("hello"),
  instanceId: z.string().min(1),
  version: z.string(),
  api: z.string().optional(),
  lastAckedSeq: seqSchema.optional(),
});
const frameSchema = z.discriminatedUnion("t", [
  helloSchema,
  z.object({ t: z.literal("welcome"), lastSeq: seqSchema }),
  z.object({
    t: z.literal("req"),
    id: seqSchema,
    method: z.string(),
    params: z.unknown().optional(),
  }),
  z.object({
    t: z.literal("res"),
    id: seqSchema,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: errorSchema.optional(),
  }),
  z.object({ t: z.literal("evt"), event: eventSchema }),
  z.object({ t: z.literal("ack"), seq: seqSchema }),
  z.object({ t: z.literal("ping") }),
  z.object({ t: z.literal("pong") }),
  z.object({ t: z.literal("part"), data: z.string(), last: z.boolean() }),
]);

export type Frame = z.infer<typeof frameSchema>;
export type WholeFrame = Exclude<Frame, { t: "part" }>;
export type Hello = z.infer<typeof helloSchema>;
export type WireError = z.infer<typeof errorSchema>;

export function encodeFrame(frame: WholeFrame): string[] {
  const text = JSON.stringify(frame);
  if (Buffer.byteLength(text) <= MAX_FRAME_BYTES) return [text];
  const parts: string[] = [];
  for (let at = 0; at < text.length; at += PART_CHARS) {
    const data = text.slice(at, at + PART_CHARS);
    const last = at + PART_CHARS >= text.length;
    parts.push(JSON.stringify({ t: "part", data, last } satisfies Frame));
  }
  return parts;
}

function parseFrame(text: string) {
  try {
    return frameSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

export function createFrameDecoder(): (text: string) => WholeFrame | null {
  let assembling = "";
  return (text) => {
    const frame = parseFrame(text);
    if (frame?.t !== "part") return frame;
    assembling += frame.data;
    const whole = frame.last ? parseFrame(assembling) : null;
    if (frame.last || assembling.length > MAX_ASSEMBLED_CHARS) assembling = "";
    return whole?.t === "part" ? null : whole;
  };
}

export function toWireError(error: unknown): WireError {
  if (error instanceof RunnerError) {
    const { code, message, retryable } = error;
    return { code, message, retryable };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "failed", message, retryable: false };
}

export function fromWireError(error: WireError | undefined): RunnerError {
  if (error === undefined) return new RunnerError("failed", "Runner failed");
  return new RunnerError(error.code, error.message, error.retryable);
}

export function connectionLost(): RunnerError {
  const message = "The connection to this machine's runner was lost";
  return new RunnerError("unavailable", message, true);
}
