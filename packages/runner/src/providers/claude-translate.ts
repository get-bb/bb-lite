import {
  backgroundTaskItemStatus,
  isBackgroundAgentTaskType,
  jsonValueSchema,
  type BackgroundTaskStatus,
  type ProviderErrorCategory,
  type ProviderErrorInfo,
  type ProviderRateLimitState,
  type ThreadEventItemPresentation as Presentation,
  type ThreadEventPlanStep as PlanStep,
  type WorkflowAgentSnapshot,
  type WorkflowPhaseSnapshot,
} from "@bb/domain";
import { z } from "zod";
import type {
  BackgroundTaskShape,
  EventBuilder,
} from "../events/event-builder.js";
import {
  classifyTool,
  classifyUnseenTool,
  completedShape,
  foldTaskResult,
  toolOutput,
  type ClassifiedTool,
  type TaskPlan,
} from "./claude-tools.js";
import * as ui from "./provider.js";

export interface TranslatorOptions {
  threadId: string;
  cwd: string;
  sandboxed: boolean;
  injected: ReadonlyMap<string, Presentation | undefined>;
}

interface Turn {
  id: string;
  responded: boolean;
  compacting: boolean;
  requestTokens?: number;
  checkpoint?: string;
  rateLimitRejection?: string;
  fallback?: string;
}

interface Task {
  id: string;
  key: { providerItemId: string; parentRef: string | undefined };
  generation: number;
  taskType: string;
  description: string;
  taskStatus: BackgroundTaskStatus;
  skipTranscript: boolean;
  workflowName: string | undefined;
  phases: Map<number, WorkflowPhaseSnapshot>;
  agents: Map<number, WorkflowAgentSnapshot>;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
  summary?: string;
  error?: string;
  outputFile?: string;
  done: boolean;
}

type Json = Record<string, unknown>;
type Category = ProviderErrorCategory | undefined;

const LARGE_CONTEXT_MODELS =
  "best claude-fable-5 claude-fable-5-1 claude-mythos-5 claude-mythos-5-1 fable";
const NO_RESPONSE = "No response requested.";
const NO_FALLBACK =
  "The selected model refused the request and no fallback model was available.";
const RESULT_ERRORS: Record<string, [Category, string] | undefined> = {
  error_during_execution: ["unknown", "failed during execution"],
  error_max_turns: ["max-turns", "reached the maximum number of turns"],
  error_max_budget_usd: ["budget-exceeded", "exceeded the configured budget"],
  error_max_structured_output_retries: [
    "structured-output-retries",
    "exhausted structured output retries",
  ],
};
const API_ERRORS: Record<string, Category> = {
  authentication_failed: "unauthorized",
  oauth_org_not_allowed: "unauthorized",
  billing_error: "billing",
  rate_limit: "rate-limit",
  invalid_request: "bad-request",
  model_not_found: "bad-request",
  server_error: "internal",
  max_output_tokens: "max-output-tokens",
  unknown: "unknown",
};
const RATE_LIMIT_LABELS: Record<string, string | undefined> = {
  five_hour: "Five-hour limit",
  seven_day: "Weekly limit",
  seven_day_opus: "Weekly Opus limit",
  seven_day_sonnet: "Weekly Sonnet limit",
  seven_day_overage_included: "Weekly included overage",
  overage: "Overage",
};
const RATE_LIMIT_STATUS: Record<string, "allowed" | "warning" | undefined> = {
  allowed: "allowed",
  allowed_warning: "warning",
};
const QUIET_TYPES = `result rate_limit_event tool_progress tool_use_summary
  command_lifecycle conversation_reset auth_status prompt_suggestion`;
const KNOWN_BLOCKS = "fallback text thinking tool_result tool_use";
const STREAM_EVENTS =
  "message_start content_block_stop message_delta message_stop ping";
const STREAM_PARTS: Record<string, string | undefined> = {
  content_block_start: "text thinking tool_use",
  content_block_delta:
    "input_json_delta signature_delta text_delta thinking_delta",
};
const KNOWN_SUBTYPES = `background_tasks_changed commands_changed
  compact_boundary control_request_progress elicitation_complete
  files_persisted hook_progress hook_response hook_started informational init
  local_command_output memory_recall mirror_error model_fallback
  model_refusal_fallback model_refusal_no_fallback notification
  permission_denied plugin_install session_state_changed status
  task_notification task_progress task_started task_updated thinking_tokens
  worker_shutting_down`;

const fields = z.record(z.string(), z.unknown());
const text = z.string();
const nonEmpty = text.min(1);
const count = z.number().optional();
const usageSchema = z.looseObject({
  input_tokens: count,
  output_tokens: count,
  cache_read_input_tokens: z.number().nonnegative().optional(),
  cache_creation_input_tokens: z.number().nonnegative().optional(),
});
const bodySchema = z.looseObject({
  content: z.array(z.looseObject({ type: text })).optional(),
});
const assistantSchema = z.object({ uuid: nonEmpty.optional() });
const userSchema = assistantSchema.extend({
  isSynthetic: z.boolean().optional(),
  parent_tool_use_id: text.nullish(),
});
const anything = z.unknown().optional();
const toolUseSchema = z.object({ id: text, name: text, input: anything });
const toolResultSchema = z.object({
  tool_use_id: text,
  tool_name: text.optional(),
  content: anything,
  is_error: z.boolean().optional(),
  tool_use_result: anything,
});
const resultSchema = z.object({
  subtype: text,
  is_error: z.boolean().optional(),
  api_error_status: z.number().nullish(),
  errors: z.array(text).optional(),
  result: anything,
  usage: anything,
  modelUsage: anything,
  origin: z.looseObject({ kind: nonEmpty }).optional(),
});
const modelUsageSchema = z.record(
  text,
  z.looseObject({ contextWindow: z.number() }),
);
const retrySchema = z.object({
  attempt: z.number(),
  max_retries: z.number(),
  retry_delay_ms: z.number(),
  error_status: z.number().nullable(),
  error: z.enum(Object.keys(API_ERRORS)),
});
const fallbackSchema = z.object({
  original_model: nonEmpty,
  fallback_model: nonEmpty,
  content: text.optional(),
});
const deniedSchema = z.object({
  tool_name: text,
  tool_use_id: text,
  decision_reason_type: text.optional(),
  decision_reason: text.optional(),
  message: text,
});
const rateLimitSchema = z.object({
  rate_limit_info: z.object({
    status: nonEmpty,
    resetsAt: count,
    rateLimitType: nonEmpty.optional(),
    overageStatus: nonEmpty.optional(),
    overageDisabledReason: nonEmpty.optional(),
  }),
});
const taskSchema = z.object({
  task_id: text,
  tool_use_id: text.optional(),
  description: text.optional(),
  task_type: text.optional(),
  workflow_name: text.optional(),
  skip_transcript: z.boolean().optional(),
  usage: z
    .object({ total_tokens: z.number(), tool_uses: z.number() })
    .extend({ duration_ms: z.number() })
    .optional(),
  workflow_progress: z.array(z.unknown()).optional(),
  status: z.enum(["completed", "failed", "stopped"]).optional(),
  output_file: text.optional(),
  summary: text.optional(),
  patch: z
    .object({
      status: z
        .enum(["pending", "running", "completed", "failed", "killed", "paused"])
        .optional(),
      description: text.optional(),
      error: text.optional(),
    })
    .optional(),
});
const index = z.number().int().min(1);
const workflowPhaseSchema = z.object({
  type: z.literal("workflow_phase"),
  index,
  title: text,
  kind: text.optional(),
});
const workflowAgentSchema = z.object({
  type: z.literal("workflow_agent"),
  index,
  label: text,
  state: text,
  model: text.optional(),
  phaseIndex: count,
  phaseTitle: text.optional(),
  agentType: text.optional(),
  isolation: text.optional(),
  queuedAt: count,
  startedAt: count,
  lastProgressAt: count,
  attempt: count,
  lastToolName: text.optional(),
  lastToolSummary: text.optional(),
  promptPreview: text.optional(),
  resultPreview: text.optional(),
  error: text.optional(),
  skipped: z.boolean().optional(),
  cached: z.boolean().optional(),
  tokens: count,
  toolCalls: count,
  durationMs: count,
});

function str(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function listed(list: string, value: string | undefined) {
  return value !== undefined && list.split(/\s+/).includes(value);
}

function blocksOf(message: unknown) {
  return bodySchema.safeParse(message).data?.content ?? [];
}

function tokens(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

export function contextWindowHint(model: string): number | null {
  const large = model.endsWith("[1m]") || listed(LARGE_CONTEXT_MODELS, model);
  if (large) return 1_000_000;
  return model === "default" ? null : 200_000;
}

function reportedContextWindow(modelUsage: unknown) {
  const usage = modelUsageSchema.safeParse(modelUsage).data ?? {};
  const windows = Object.entries(usage).flatMap(([model, entry]) => {
    const reported = entry.contextWindow;
    if (!Number.isFinite(reported) || reported <= 0) return [];
    return [Math.max(reported, contextWindowHint(model) ?? 0)];
  });
  return windows.length === 0 ? null : Math.max(...windows);
}

function httpCategory(status: number): ProviderErrorCategory {
  if (status === 402) return "billing";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate-limit";
  if (status === 529) return "overloaded";
  if (status >= 400 && status < 500) return "bad-request";
  return status >= 500 && status < 600 ? "internal" : "unknown";
}

function errorInfo(args: {
  code?: string;
  status?: number | null;
  subtype?: string;
}): ProviderErrorInfo | undefined {
  const httpStatusCode = args.status ?? null;
  const fromCode = args.code === undefined ? undefined : API_ERRORS[args.code];
  const fromStatus =
    httpStatusCode === null ? undefined : httpCategory(httpStatusCode);
  const fromSubtype = RESULT_ERRORS[args.subtype ?? ""]?.[0];
  const overloaded = fromCode !== undefined && httpStatusCode === 529;
  const category = overloaded
    ? "overloaded"
    : fromCode === "unknown"
      ? (fromStatus ?? "unknown")
      : (fromCode ?? fromStatus ?? fromSubtype ?? "unknown");
  const resultCode = fromSubtype === undefined ? null : (args.subtype ?? null);
  const providerCode = args.code ?? resultCode;
  const empty =
    category === "unknown" && providerCode === null && httpStatusCode === null;
  return empty ? undefined : { category, providerCode, httpStatusCode };
}

function rateLimitState(
  info: z.infer<typeof rateLimitSchema>["rate_limit_info"],
): ProviderRateLimitState {
  const rejected = info.status === "rejected";
  const open = RATE_LIMIT_STATUS[info.status] ?? "unknown";
  const status = rejected ? "blocked" : open;
  const softened = RATE_LIMIT_STATUS[info.overageStatus ?? ""];
  const overage = info.overageStatus === "rejected" ? "rejected" : softened;
  const providerKey = info.rateLimitType ?? null;
  const resetsAtMs = info.resetsAt === undefined ? null : info.resetsAt * 1_000;
  const label = RATE_LIMIT_LABELS[providerKey ?? ""] ?? null;
  const subscription = providerKey === null ? "unknown" : "subscription-window";
  return {
    providerId: "claude-code",
    status: (rejected ? softened : undefined) ?? status,
    kind: providerKey === "overage" ? "credits" : subscription,
    windows: [{ providerKey, label, status, resetsAtMs }],
    reachedReason: rejected ? (providerKey ?? "rate_limit_rejected") : null,
    overageStatus:
      info.overageStatus === undefined ? null : (overage ?? "unavailable"),
    overageReason: info.overageDisabledReason ?? null,
  };
}

function describeRaw(message: Json): { kind: string; unknown: boolean } {
  const type = str(message.type);
  if (type === "assistant" || type === "user") {
    const distinct = new Set(blocksOf(message.message).map((b) => b.type));
    const names = [...distinct].map((name) =>
      listed(KNOWN_BLOCKS, name) ? name : "unknown",
    );
    const types = names.sort();
    const suffix = types.length === 0 ? "" : `:${types.join("+")}`;
    const kind = `sdk/${type}${suffix}`;
    const spoken = types.length > 0 && !types.includes("unknown");
    const known =
      type === "assistant"
        ? spoken && !types.includes("tool_result")
        : kind === "sdk/user:text" || kind === "sdk/user:tool_result";
    return { kind, unknown: !known };
  }
  if (type === "system") {
    const subtype = str(message.subtype);
    const known = listed(KNOWN_SUBTYPES, subtype);
    const kind = known ? `sdk/system:${subtype}` : "sdk/system";
    return { kind, unknown: !known };
  }
  if (type === "stream_event") {
    const event = fields.safeParse(message.event).data ?? {};
    const name = str(event.type) ?? "";
    const parts = STREAM_PARTS[name];
    const block = fields.safeParse(event.content_block ?? event.delta).data;
    const part = str(block?.type);
    const nested = parts !== undefined;
    const known = nested ? listed(parts, part) : listed(STREAM_EVENTS, name);
    const path = [
      ...(nested || known ? [name] : []),
      ...(nested ? [part] : []),
    ];
    const kind = ["sdk/stream_event", ...path.slice(0, known ? 2 : 1)];
    return { kind: kind.join(":"), unknown: !known };
  }
  const kind = type ? `sdk/${type}` : "sdk/unknown";
  return { kind, unknown: !listed(QUIET_TYPES, type) };
}

export class ClaudeTranslator {
  private turn: Turn = { id: "", responded: false, compacting: false };
  private total = ui.ZERO_TOKEN_USAGE;
  private contextWindow: number | null = null;
  private suppressed = false;
  private readonly tools = new Map<string, ClassifiedTool>();
  private readonly tasks = new Map<string, Task>();
  private readonly plan: TaskPlan = new Map();

  constructor(
    private readonly events: EventBuilder,
    private readonly options: TranslatorOptions,
  ) {}

  setModel(model: string) {
    this.contextWindow = contextWindowHint(model);
  }

  acceptInput() {
    this.suppressed = false;
  }

  stopTasks() {
    for (const task of this.tasks.values()) {
      if (task.done) continue;
      const settled = backgroundTaskItemStatus(task.taskStatus) !== "pending";
      if (!settled) task.taskStatus = "stopped";
      this.closeTask(task);
    }
  }

  handle(raw: unknown) {
    const message = fields.safeParse(raw).data;
    if (message === undefined) return;
    const parentRef = str(message.parent_tool_use_id) || undefined;
    try {
      if (this.dispatch(message, parentRef)) return;
      const { kind, unknown } = describeRaw(message);
      if (unknown) this.unhandled(kind, message, parentRef);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      this.events.warning({ summary: "Claude Code event ignored", details });
    }
  }

  private dispatch(message: Json, parentRef: string | undefined): boolean {
    switch (message.type) {
      case "assistant":
        return this.assistant(message, parentRef);
      case "user":
        return this.user(message, parentRef);
      case "stream_event":
        return this.stream(message, parentRef);
      case "result":
        return this.result(message, parentRef);
      case "system":
        return this.system(message);
      case "rate_limit_event":
        return this.rateLimit(message, parentRef);
      case "conversation_reset":
        if (this.blocked()) return false;
        this.ensureTurn();
        this.events.cleared();
        return true;
      default:
        return false;
    }
  }

  private blocked() {
    return this.suppressed && this.events.activeTurnId === null;
  }

  private activeTurn(): Turn | null {
    const turnId = this.events.activeTurnId;
    if (turnId === null) return null;
    if (this.turn.id !== turnId) {
      this.turn = { id: turnId, responded: false, compacting: false };
      this.tools.clear();
    }
    return this.turn;
  }

  private ensureTurn(): Turn {
    if (this.events.activeTurnId === null) this.events.openTurn();
    const turn = this.activeTurn() ?? this.turn;
    turn.responded = true;
    return turn;
  }

  private hasBlockingTasks() {
    const blocking = (task: Task) =>
      !task.done &&
      !task.skipTranscript &&
      isBackgroundAgentTaskType(task.taskType);
    return [...this.tasks.values()].some(blocking);
  }

  private unhandled(kind: string, message: Json, parentRef?: string) {
    const { threadId } = this.options;
    const serializationError =
      "Provider raw event params were not JSON-serializable.";
    const params = jsonValueSchema.safeParse({ threadId, message }).data;
    const rawEvent = {
      jsonrpc: "2.0" as const,
      method: "sdk/message",
      params: params ?? { serializationError },
    };
    this.events.unhandled(kind, rawEvent, { inTurn: true, parentRef });
    return true;
  }

  private unexpected(message: Json, parentRef?: string) {
    return this.unhandled(describeRaw(message).kind, message, parentRef);
  }

  private planSteps(steps: PlanStep[], parentRef: string | undefined) {
    const active = steps.find((step) => step.status === "active")?.step;
    const presentation = { ...ui.labels.planSteps(active), suppress: true };
    const options = { status: "completed" as const, presentation };
    const key = { channel: "planSteps", parentRef };
    this.events.closeItem(key, { type: "planSteps", steps }, options);
  }

  private modelFallback(
    originalModel: string,
    fallbackModel: string,
    reason: "refusal" | "provider",
    content?: string,
  ) {
    const key = `${originalModel}\u0000${fallbackModel}`;
    if (this.turn.fallback === key) return;
    this.turn.fallback = key;
    const message =
      content ?? `Switched from ${originalModel} to ${fallbackModel}.`;
    const transition = { originalModel, fallbackModel, reason, message };
    this.events.modelFallback(transition);
  }

  private reportContext(
    usedTokens: number | null,
    modelContextWindow: number | null,
    openTurnOnly: boolean,
  ) {
    const usage = { usedTokens, modelContextWindow, estimated: true };
    const report = { contextWindowUsage: usage };
    this.events.contextWindow(report, undefined, openTurnOnly);
  }

  private assistant(message: Json, parentRef: string | undefined): boolean {
    const parsed = assistantSchema.safeParse(message);
    if (!parsed.success) return this.unexpected(message, parentRef);
    if (this.blocked()) return false;
    const body = fields.safeParse(message.message).data ?? {};
    const content = blocksOf(body);
    const reply = content
      .flatMap((block) => (block.type === "text" ? [str(block.text)] : []))
      .filter((part) => part !== undefined)
      .join("\n")
      .trim();
    const usage = usageSchema.safeParse(body.usage).data;
    const synthetic =
      body.model === "<synthetic>" &&
      body.role === "assistant" &&
      body.stop_reason === "stop_sequence" &&
      body.stop_sequence === "" &&
      message.error === undefined &&
      message.isApiErrorMessage !== true &&
      message.apiErrorStatus === undefined &&
      Object.keys(usageSchema.shape).every((key) => usage?.[key] === 0) &&
      reply === NO_RESPONSE;
    if (synthetic && this.events.activeTurnId === null) return false;
    const turn = this.ensureTurn();
    if (parentRef === undefined) {
      turn.checkpoint = parsed.data.uuid ?? turn.checkpoint;
    }
    const fallbacks = content.filter((block) => block.type === "fallback");
    if (fallbacks.length > 0 && fallbacks.length === content.length) {
      const [from, to] = [fallbacks[0]?.from, fallbacks[0]?.to].map(
        (side) => str(fields.safeParse(side).data?.model) ?? "",
      );
      if (from && to) this.modelFallback(from, to, "provider");
      return true;
    }
    if (synthetic) {
      const checkpointId = turn.checkpoint;
      const settled = !this.hasBlockingTasks();
      if (settled) this.events.closeTurn({ status: "completed", checkpointId });
      return true;
    }
    if (parentRef === undefined && usage !== undefined) {
      turn.requestTokens =
        tokens(usage.input_tokens) +
        tokens(usage.cache_read_input_tokens) +
        tokens(usage.cache_creation_input_tokens);
      this.reportContext(turn.requestTokens, this.contextWindow, true);
    }
    for (const block of content) {
      const thinking = block.type === "thinking" ? str(block.thinking) : "";
      const key = { channel: "thinking", parentRef };
      if (thinking) this.events.textClose(key, "reasoningText", thinking);
    }
    if (reply) {
      const key = { channel: "assistant", parentRef };
      this.events.textClose(key, "agentMessage", reply);
    }
    for (const block of content) {
      const use = toolUseSchema.safeParse(block).data;
      if (block.type !== "tool_use" || use === undefined) continue;
      const tool = classifyTool(use.name, use.id, use.input, this.options);
      this.tools.set(use.id, tool);
      const key = { providerItemId: use.id, parentRef };
      const { presentation, planSteps } = tool;
      this.events.openItem(key, tool.shape, { presentation });
      if (planSteps !== undefined) this.planSteps(planSteps, parentRef);
    }
    return true;
  }

  private stream(message: Json, parentRef: string | undefined): boolean {
    if (this.blocked()) return false;
    const event = fields.safeParse(message.event).data ?? {};
    const source =
      event.type === "content_block_delta"
        ? { part: event.delta, text: "text_delta", thinking: "thinking_delta" }
        : event.type === "content_block_start"
          ? { part: event.content_block, text: "text", thinking: "thinking" }
          : undefined;
    const part = fields.safeParse(source?.part).data;
    if (source === undefined || part === undefined) return false;
    const thinking = part.type === source.thinking && str(part.thinking);
    const reply = part.type === source.text && str(part.text);
    if (!thinking && !reply) return false;
    this.ensureTurn();
    if (thinking) {
      const key = { channel: "thinking", parentRef };
      this.events.delta(key, "reasoningText", thinking);
    }
    if (reply) {
      const key = { channel: "assistant", parentRef };
      this.events.delta(key, "agentMessage", reply);
    }
    return true;
  }

  private user(message: Json, parentRef: string | undefined): boolean {
    const parsed = userSchema.safeParse(message);
    if (!parsed.success) return this.unexpected(message, parentRef);
    const results = blocksOf(message.message).flatMap((block) => {
      const result = toolResultSchema.safeParse(block).data;
      return block.type === "tool_result" && result ? [result] : [];
    });
    const turn = this.activeTurn();
    if (results.length === 0) {
      const { uuid, isSynthetic, parent_tool_use_id: parent } = parsed.data;
      const prompt = !isSynthetic && parent == null && parentRef === undefined;
      if (turn !== null && prompt) turn.checkpoint ??= uuid;
      return false;
    }
    if (turn === null) return this.unexpected(message, parentRef);
    const envelope = results.length === 1 ? message.tool_use_result : undefined;
    for (const block of results) {
      const started = this.tools.get(block.tool_use_id);
      this.tools.delete(block.tool_use_id);
      const base =
        started ?? classifyUnseenTool(block.tool_name, this.options.cwd);
      const failed = block.is_error ?? false;
      const output = toolOutput(base.shape, {
        toolName: block.tool_name,
        content: block.content,
        processResult: block.tool_use_result,
      });
      const key = { providerItemId: block.tool_use_id, parentRef };
      const shape = completedShape(base.shape, output, failed);
      const status = failed ? "failed" : "completed";
      const { presentation } = base;
      this.events.closeItem(key, shape, { status, presentation });
      const call = started?.shape.type === "toolCall" ? started.shape : null;
      const tool = call?.tool ?? block.tool_name;
      if (failed || tool === undefined) continue;
      const taskOutput = envelope ?? block.tool_use_result ?? output;
      const steps = foldTaskResult(
        this.plan,
        tool,
        call?.arguments,
        taskOutput,
      );
      if (steps !== null) this.planSteps(steps, parentRef);
    }
    return true;
  }

  private result(message: Json, parentRef: string | undefined): boolean {
    const parsed = resultSchema.safeParse(message);
    if (!parsed.success) return this.unexpected(message, parentRef);
    const result = parsed.data;
    const turn = this.activeTurn();
    const human = result.origin === undefined || result.origin.kind === "human";
    if (turn === null || (!turn.responded && !human)) return false;
    turn.responded = true;
    const reported = reportedContextWindow(result.modelUsage);
    const window = reported ?? this.contextWindow;
    const used = turn.requestTokens ?? null;
    this.contextWindow = window;
    if (used !== null || window !== null)
      this.reportContext(used, window, true);
    const usage = usageSchema.safeParse(result.usage).data;
    if (usage !== undefined || reported !== null) {
      const input = tokens(usage?.input_tokens);
      const output = tokens(usage?.output_tokens);
      const read = usage?.cache_read_input_tokens;
      const write = usage?.cache_creation_input_tokens;
      const cached = tokens(read) + tokens(write);
      const last = {
        totalTokens: input + output + cached,
        inputTokens: input,
        cachedInputTokens: cached,
        ...(read === undefined ? {} : { cacheReadInputTokens: read }),
        ...(write === undefined ? {} : { cacheWriteInputTokens: write }),
        outputTokens: output,
        reasoningOutputTokens: 0,
      };
      this.total = ui.addTokenUsage(this.total, last);
      const tokenUsage = { total: this.total, last };
      this.events.usage({
        tokenUsage: { ...tokenUsage, modelContextWindow: reported },
      });
    }
    const rejection = turn.rateLimitRejection;
    turn.rateLimitRejection = undefined;
    const { subtype, api_error_status: status } = result;
    const errored = result.is_error === true || subtype.startsWith("error");
    const failed = errored || rejection !== undefined;
    if (failed) {
      const info = errorInfo({ status, subtype });
      const limited = {
        category: "rate-limit" as const,
        providerCode: info?.providerCode ?? "rate_limit_event",
        httpStatusCode: info?.httpStatusCode ?? null,
      };
      const errors = (result.errors ?? []).map((e) => e.trim()).filter(Boolean);
      const known = RESULT_ERRORS[subtype]?.[1];
      const generic = known
        ? `Claude Code ${known}.`
        : `Claude Code result failed: ${subtype}`;
      const reason =
        result.is_error && typeof result.result === "string"
          ? result.result
          : errors.join("\n") || generic;
      this.events.error({
        detail: errored ? reason : rejection,
        errorInfo: rejection === undefined ? info : limited,
      });
    } else if (this.hasBlockingTasks()) {
      return true;
    }
    this.suppressed = failed;
    const checkpointId = turn.checkpoint;
    const outcome = failed ? "failed" : "completed";
    this.events.closeTurn({ status: outcome, checkpointId });
    return true;
  }

  private rateLimit(message: Json, parentRef: string | undefined): boolean {
    const parsed = rateLimitSchema.safeParse(message);
    if (!parsed.success) return this.unexpected(message, parentRef);
    const info = parsed.data.rate_limit_info;
    const state = rateLimitState(info);
    const softened = RATE_LIMIT_STATUS[info.overageStatus ?? ""] !== undefined;
    const hard = info.status === "rejected" && !softened;
    if (hard && !this.blocked()) {
      const detail = [
        "Claude Code rate limit rejected",
        info.rateLimitType && `type ${info.rateLimitType}`,
        info.resetsAt !== undefined && `resetsAt ${info.resetsAt}`,
        info.overageStatus && `overage ${info.overageStatus}`,
        info.overageDisabledReason &&
          `overage disabled: ${info.overageDisabledReason}`,
      ];
      this.ensureTurn().rateLimitRejection = detail.filter(Boolean).join("; ");
    } else if (!hard && state.status === "allowed") {
      const turn = this.activeTurn();
      if (turn !== null) turn.rateLimitRejection = undefined;
    }
    this.events.rateLimits(state);
    return true;
  }

  private system(message: Json): boolean {
    switch (message.subtype) {
      case "api_retry": {
        const retry = retrySchema.safeParse(message).data;
        if (retry === undefined) return false;
        const status = retry.error_status;
        const http = status === null ? "" : ` HTTP ${status}`;
        const attempt = `${retry.attempt}/${retry.max_retries}`;
        const detail = `Claude Code API retry ${attempt} after ${retry.retry_delay_ms}ms:${http} ${retry.error}`;
        const threadScoped = this.blocked();
        if (!threadScoped) this.ensureTurn();
        const info = errorInfo({ code: retry.error, status });
        const report = { detail, willRetry: true, errorInfo: info };
        this.events.error(report, { threadScoped });
        return true;
      }
      case "status": {
        const compaction = { type: "contextCompaction" as const };
        const key = { channel: "compaction" };
        const presentation = ui.labels.compaction;
        if (message.status === "compacting") {
          if (this.blocked()) return false;
          this.ensureTurn().compacting = true;
          this.events.openItem(key, compaction, { presentation });
          return true;
        }
        const turn = this.turn;
        const wasCompacting = turn.compacting;
        turn.compacting = false;
        if (!wasCompacting || this.activeTurn() !== turn) return false;
        const options = { status: "completed" as const, presentation };
        this.events.closeItem(key, compaction, options);
        return true;
      }
      case "compact_boundary":
        this.events.compacted();
        this.reportContext(null, null, false);
        return true;
      case "model_fallback":
      case "model_refusal_fallback": {
        const fallback = fallbackSchema.safeParse(message).data;
        if (fallback === undefined) return false;
        const refused = message.subtype === "model_refusal_fallback";
        const { original_model: from, fallback_model: to } = fallback;
        const reason = refused ? "refusal" : "provider";
        this.modelFallback(from, to, reason, fallback.content);
        return true;
      }
      case "model_refusal_no_fallback": {
        const details = str(message.content) ?? NO_FALLBACK;
        const summary = "Model refused the request";
        this.events.warning({ summary, details }, true);
        return true;
      }
      case "permission_denied": {
        const denied = deniedSchema.safeParse(message).data;
        if (denied === undefined) return false;
        const reason = denied.decision_reason ?? denied.message;
        const kind = denied.decision_reason_type;
        const summary = `${denied.tool_name} was denied automatically`;
        const details = kind ? `${reason} (${kind})` : reason;
        this.events.warning({ summary, details }, true);
        return true;
      }
      default:
        return this.task(message);
    }
  }

  private taskShape(task: Task): BackgroundTaskShape {
    const byIndex = (a: { index: number }, b: { index: number }) =>
      a.index - b.index;
    const phases = [...task.phases.values()].sort(byIndex);
    const agents = [...task.agents.values()].sort(byIndex);
    const tracked = phases.length > 0 || agents.length > 0;
    return {
      type: "backgroundTask",
      familyId: task.id,
      taskType: task.taskType,
      description: task.description,
      taskStatus: task.taskStatus,
      skipTranscript: task.skipTranscript,
      workflowName: task.workflowName,
      workflow: tracked ? { phases, agents } : undefined,
      usage: task.usage,
      summary: task.summary,
      error: task.error,
      outputFile: task.outputFile,
    };
  }

  private taskPresentation(task: Task) {
    if (task.taskType === "local_workflow") {
      const title = task.workflowName ?? task.description;
      const completed = "Workflow finished";
      return ui.presentation("Running workflow", completed, "Workflow", title);
    }
    const command = task.taskType === "local_bash";
    const noun = command ? "command" : "agent";
    return ui.presentation(
      `Running background ${noun}`,
      `Background ${noun} finished`,
      command ? "Terminal" : "UserRound",
      task.description,
    );
  }

  private closeTask(task: Task) {
    task.done = true;
    const status = backgroundTaskItemStatus(task.taskStatus);
    const presentation = this.taskPresentation(task);
    const options = { status, presentation };
    this.events.closeItem(task.key, this.taskShape(task), options);
  }

  private foldWorkflow(task: Task, records: unknown[]) {
    const whole = (n?: number) =>
      n !== undefined && Number.isInteger(n) && n > 0;
    for (const raw of records) {
      const phase = workflowPhaseSchema.safeParse(raw).data;
      if (phase !== undefined) {
        const { index: phaseIndex, title, kind } = phase;
        task.phases.set(phaseIndex, { index: phaseIndex, title, kind });
      }
      const agent = workflowAgentSchema.safeParse(raw).data;
      if (agent === undefined) continue;
      const { skipped, phaseIndex, attempt, lastProgressAt, ...rest } = agent;
      const queued =
        agent.startedAt === undefined && agent.queuedAt !== undefined;
      const failed = skipped === true ? "skipped" : "failed";
      const live = queued ? "queued" : "running";
      const errored = agent.state === "error" ? failed : live;
      task.agents.set(agent.index, {
        ...{ ...rest, type: undefined },
        state: agent.state === "done" ? "done" : errored,
        model: agent.model ?? "unknown",
        attempt: whole(attempt) ? (attempt ?? 1) : 1,
        cached: agent.cached ?? false,
        lastProgressAt:
          lastProgressAt ?? agent.startedAt ?? agent.queuedAt ?? 0,
        ...(whole(phaseIndex) ? { phaseIndex } : {}),
      });
    }
  }

  private task(message: Json): boolean {
    const parsed = taskSchema.safeParse(message).data;
    if (parsed === undefined) return false;
    const known = this.tasks.get(parsed.task_id);
    const usage = parsed.usage && {
      totalTokens: parsed.usage.total_tokens,
      toolUses: parsed.usage.tool_uses,
      durationMs: parsed.usage.duration_ms,
    };
    if (message.subtype === "task_started") {
      const taskType = parsed.task_type ?? "unknown";
      const shown =
        listed("local_workflow local_bash", taskType) ||
        isBackgroundAgentTaskType(taskType);
      const { tool_use_id: parentRef, description } = parsed;
      const orphan = parentRef !== undefined && !this.tools.has(parentRef);
      const fresh = known === undefined ? !orphan : known.done;
      const start = shown && fresh && !this.blocked();
      if (!start || description === undefined) return false;
      const generation = (known?.generation ?? 0) + 1;
      const suffix = generation > 1 ? `#${generation}` : "";
      const providerItemId = `task:${parsed.task_id}${suffix}`;
      const task: Task = {
        id: parsed.task_id,
        key: { providerItemId, parentRef },
        generation,
        taskType,
        description,
        taskStatus: "running",
        skipTranscript: parsed.skip_transcript ?? false,
        workflowName: parsed.workflow_name,
        phases: new Map(),
        agents: new Map(),
        done: false,
      };
      this.tasks.set(task.id, task);
      this.ensureTurn();
      const presentation = this.taskPresentation(task);
      this.events.openItem(task.key, this.taskShape(task), { presentation });
      return true;
    }
    if (known === undefined || known.done) return false;
    const progress = (flush: boolean) => {
      const status = backgroundTaskItemStatus(known.taskStatus);
      const snapshot = { shape: this.taskShape(known), status };
      this.events.progress(known.key, { snapshot, flush });
      return true;
    };
    const { patch, status, summary, output_file: file } = parsed;
    switch (message.subtype) {
      case "task_progress":
        if (usage === undefined || parsed.description === undefined)
          return false;
        this.foldWorkflow(known, parsed.workflow_progress ?? []);
        known.usage = usage;
        return progress(false);
      case "task_updated": {
        if (patch === undefined) return false;
        const changed = (patch.status ?? known.taskStatus) !== known.taskStatus;
        known.taskStatus = patch.status ?? known.taskStatus;
        known.description = patch.description ?? known.description;
        known.error = patch.error ?? known.error;
        return progress(changed);
      }
      case "task_notification":
        if (!status || summary === undefined || file === undefined)
          return false;
        known.taskStatus = status;
        known.summary = summary;
        known.outputFile = file || known.outputFile;
        known.usage = usage ?? known.usage;
        this.closeTask(known);
        return true;
      default:
        return false;
    }
  }
}
