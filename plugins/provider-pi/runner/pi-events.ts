import { z } from "zod";
import {
  ZERO_TOKEN_USAGE,
  addTokenUsage,
  buildEditDiff,
  labels,
  type EventBuilder,
  type ItemShape,
} from "@bb/runner";
import type { ThreadEventItemPresentation as Presentation } from "@bb/domain";

const ASSISTANT = { channel: "assistant" };
const COMMAND_TOOLS = new Set(["bash"]);
const FILE_TOOLS = new Set(["edit", "write"]);

const record = z.record(z.string(), z.unknown());
const usageSchema = z
  .object({
    input: z.number().optional(),
    output: z.number().optional(),
    cacheRead: z.number().optional(),
    cacheWrite: z.number().optional(),
    totalTokens: z.number().optional(),
  })
  .passthrough();
const contentSchema = z.array(
  z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
);
const assistantSchema = z
  .object({
    role: z.literal("assistant"),
    content: contentSchema.optional(),
    usage: usageSchema.optional(),
    stopReason: z.string().optional(),
    errorMessage: z.string().optional(),
  })
  .passthrough();
const agentEndSchema = z.object({
  messages: z.array(z.unknown()).default([]),
  willRetry: z.boolean().optional(),
  providerCheckpointId: z.string().optional(),
});
const messageUpdateSchema = z.object({
  assistantMessageEvent: z
    .object({
      type: z.string(),
      contentIndex: z.number().optional(),
      delta: z.string().optional(),
      content: z.string().optional(),
    })
    .passthrough(),
});
const toolStartSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  args: z.unknown().optional(),
});
const toolEndSchema = toolStartSchema.extend({
  result: z.unknown().optional(),
  isError: z.boolean().optional(),
});
const toolUpdateSchema = toolStartSchema.extend({
  partialResult: z.unknown().optional(),
});
const resultSchema = z.object({ content: contentSchema }).passthrough();
const bashArgsSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
});
const editArgsSchema = z
  .object({
    path: z.string().min(1),
    oldText: z.string().optional(),
    newText: z.string().optional(),
    content: z.string().optional(),
    edits: z
      .array(z.object({ oldText: z.string(), newText: z.string() }))
      .optional(),
  })
  .passthrough();

interface Started {
  shape: ItemShape;
  presentation: Presentation;
  startedAt: number;
}

export type PiUsage = ReturnType<typeof toUsage>;

function textOf(content: unknown) {
  const parsed = resultSchema.safeParse(content);
  if (!parsed.success) return undefined;
  const parts = parsed.data.content.flatMap((part) =>
    part.type === "text" && part.text !== undefined ? [part.text] : [],
  );
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function toUsage(usage: z.infer<typeof usageSchema>) {
  const inputTokens = Math.max(0, usage.input ?? 0);
  const outputTokens = Math.max(0, usage.output ?? 0);
  const cacheRead = Math.max(0, usage.cacheRead ?? 0);
  const cacheWrite = Math.max(0, usage.cacheWrite ?? 0);
  const cachedInputTokens = cacheRead + cacheWrite;
  const total = Math.max(0, usage.totalTokens ?? 0);
  return {
    totalTokens: total || inputTokens + outputTokens + cachedInputTokens,
    inputTokens,
    cachedInputTokens,
    ...(usage.cacheRead === undefined
      ? {}
      : { cacheReadInputTokens: cacheRead }),
    ...(usage.cacheWrite === undefined
      ? {}
      : { cacheWriteInputTokens: cacheWrite }),
    outputTokens,
    reasoningOutputTokens: 0,
  };
}

function classify(tool: string, args: unknown, cwd: string): Started {
  const startedAt = Date.now();
  const call = (): Started => {
    const parsed = record.safeParse(args);
    const shape: ItemShape = {
      type: "toolCall",
      tool,
      arguments: parsed.success ? parsed.data : undefined,
    };
    return { shape, presentation: labels.tool(tool), startedAt };
  };
  if (COMMAND_TOOLS.has(tool)) {
    const parsed = bashArgsSchema.safeParse(args);
    if (!parsed.success) return call();
    const { command } = parsed.data;
    const shape: ItemShape = {
      type: "commandExecution",
      command,
      cwd: parsed.data.cwd ?? cwd,
    };
    return { shape, presentation: labels.command(command), startedAt };
  }
  if (FILE_TOOLS.has(tool)) {
    const parsed = editArgsSchema.safeParse(args);
    if (!parsed.success) return call();
    const { path, edits, oldText } = parsed.data;
    const newText = parsed.data.newText ?? parsed.data.content;
    const update = tool === "edit" || oldText !== undefined;
    const pairs = edits && edits.length > 0 ? edits : [{ oldText, newText }];
    const changes = pairs.map((pair) => ({
      path,
      kind: update ? ("update" as const) : ("add" as const),
      diff: buildEditDiff(
        path,
        update ? pair.oldText : undefined,
        pair.newText,
      ),
    }));
    const shape: ItemShape = { type: "fileChange", changes };
    return { shape, presentation: labels.fileChange([path]), startedAt };
  }
  return call();
}

export class PiTranslator {
  private readonly tools = new Map<string, Started>();
  private total = ZERO_TOKEN_USAGE;
  turnId: string | undefined;
  interrupted = false;
  private closed = false;

  constructor(
    private readonly events: EventBuilder,
    private readonly cwd: string,
  ) {}

  handle(event: Record<string, unknown>) {
    switch (event.type) {
      case "agent_start":
        this.interrupted = false;
        this.turnId = this.events.openTurn();
        return;
      case "agent_end":
        return this.agentEnd(event);
      case "message_end":
        return this.messageEnd(event);
      case "message_update":
        return this.messageUpdate(event);
      case "tool_execution_start":
        return this.toolStart(event);
      case "tool_execution_update":
        return this.toolUpdate(event);
      case "tool_execution_end":
        return this.toolEnd(event);
      default:
        return;
    }
  }

  private messageUpdate(event: unknown) {
    const parsed = messageUpdateSchema.safeParse(event);
    if (!parsed.success) return;
    const { type, delta, content, contentIndex } =
      parsed.data.assistantMessageEvent;
    const thinking = { channel: `thinking-${contentIndex ?? 0}` };
    if (type === "text_delta" && delta) {
      this.closed = false;
      this.events.delta(ASSISTANT, "agentMessage", delta);
    } else if (type === "thinking_delta" && delta) {
      this.events.delta(thinking, "reasoningText", delta);
    } else if (type === "thinking_end" && content) {
      this.events.textClose(thinking, "reasoningText", content);
    }
  }

  private messageEnd(event: unknown) {
    const parsed = z.object({ message: assistantSchema }).safeParse(event);
    if (!parsed.success) return;
    const text = textOf({ content: parsed.data.message.content ?? [] });
    if (!text) return;
    this.closed = true;
    this.events.textClose(ASSISTANT, "agentMessage", text);
  }

  private toolStart(event: unknown) {
    const parsed = toolStartSchema.safeParse(event);
    if (!parsed.success) return;
    const { toolCallId, toolName, args } = parsed.data;
    const started = classify(toolName, args, this.cwd);
    this.tools.set(toolCallId, started);
    const { shape, presentation } = started;
    this.events.openItem({ providerItemId: toolCallId }, shape, {
      presentation,
    });
  }

  private toolUpdate(event: unknown) {
    const parsed = toolUpdateSchema.safeParse(event);
    if (!parsed.success) return;
    const { toolCallId, toolName, partialResult } = parsed.data;
    if (COMMAND_TOOLS.has(toolName)) return;
    const message = textOf(partialResult) ?? `Running ${toolName}`;
    this.events.progress({ providerItemId: toolCallId }, { message });
  }

  private toolEnd(event: unknown) {
    const parsed = toolEndSchema.safeParse(event);
    if (!parsed.success) return;
    const { toolCallId, toolName, result, isError } = parsed.data;
    const started =
      this.tools.get(toolCallId) ?? classify(toolName, undefined, this.cwd);
    this.tools.delete(toolCallId);
    const text = textOf(result);
    const durationMs = Date.now() - started.startedAt;
    const shape: ItemShape =
      started.shape.type === "commandExecution"
        ? {
            ...started.shape,
            aggregatedOutput: text,
            exitCode: isError ? 1 : 0,
            durationMs,
          }
        : started.shape.type === "toolCall"
          ? {
              ...started.shape,
              durationMs,
              ...(isError
                ? { error: text ?? "Tool failed" }
                : { result: text }),
            }
          : started.shape;
    const status = isError ? "failed" : "completed";
    const { presentation } = started;
    const key = { providerItemId: toolCallId };
    this.events.closeItem(key, shape, { status, presentation });
  }

  private agentEnd(event: unknown) {
    const parsed = agentEndSchema.safeParse(event);
    if (!parsed.success) return;
    const assistants = parsed.data.messages.flatMap((message) => {
      const result = assistantSchema.safeParse(message);
      return result.success ? [result.data] : [];
    });
    const last = assistants.at(-1);
    const checkpointId = parsed.data.providerCheckpointId;
    const failure =
      last?.stopReason === "error" && last.errorMessage?.trim()
        ? last.errorMessage
        : undefined;
    if (failure !== undefined) {
      const report = { message: "Provider error", detail: failure };
      if (parsed.data.willRetry) {
        this.events.error({ ...report, willRetry: true });
        return;
      }
      this.tools.clear();
      this.events.error(report);
      this.finish("failed", checkpointId, failure);
      return;
    }
    if (parsed.data.willRetry) return;
    this.tools.clear();
    if (this.interrupted || last?.stopReason === "aborted") {
      this.events.settle("interrupted");
      this.turnId = undefined;
      return;
    }
    const text = textOf({ content: last?.content ?? [] });
    if (text && !this.closed) {
      this.events.textClose(ASSISTANT, "agentMessage", text);
    }
    this.closed = false;
    if (last?.usage) {
      const usage = toUsage(last.usage);
      this.total = addTokenUsage(this.total, usage);
      const tokenUsage = { total: this.total, last: usage };
      this.events.usage({ ...tokenUsage, modelContextWindow: null });
    }
    this.finish("completed", checkpointId);
  }

  private finish(
    status: "completed" | "failed",
    checkpointId?: string,
    error?: string,
  ) {
    if (this.turnId === undefined) this.events.openTurn();
    this.events.closeTurn({ status, error, checkpointId });
    this.turnId = undefined;
  }
}
