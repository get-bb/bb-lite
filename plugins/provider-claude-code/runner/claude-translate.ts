import {
  backgroundTaskItemStatus as itemStatus,
  isBackgroundAgentTaskType,
  type ProviderErrorCategory as Category,
  type ProviderErrorInfo,
  type ThreadEventPlanStep as PlanStep,
} from "@bb/domain";
import { z } from "zod";
import type { BackgroundTaskShape, EventBuilder } from "@bb/runner";
import * as tools from "./claude-tools.js";
import { fields, text as str } from "./claude-tools.js";
import * as ui from "@bb/runner";

interface Turn {
  id: string;
  responded: boolean;
  compacting: boolean;
  requestTokens?: number;
  checkpoint?: string;
  fallback?: string;
}

interface Task {
  key: { providerItemId: string; parentRef: string | undefined };
  generation: number;
  done: boolean;
  item: BackgroundTaskShape;
}

type Json = Record<string, unknown>;

const LARGE_CONTEXT_MODELS =
  "best claude-fable-5 claude-fable-5-1 claude-mythos-5 claude-mythos-5-1 fable";
const ERRORS: Record<string, Category | undefined> = {
  authentication_failed: "unauthorized",
  oauth_org_not_allowed: "unauthorized",
  billing_error: "billing",
  rate_limit: "rate-limit",
  invalid_request: "bad-request",
  model_not_found: "bad-request",
  server_error: "internal",
  max_output_tokens: "max-output-tokens",
  unknown: "unknown",
  error_during_execution: "unknown",
  error_max_turns: "max-turns",
  error_max_budget_usd: "budget-exceeded",
  error_max_structured_output_retries: "structured-output-retries",
};
const TASK_TYPES = "local_workflow local_bash local_agent local_subagent";
const count = z.number().optional();
const usageSchema = z.looseObject({
  input_tokens: count,
  output_tokens: count,
  cache_read_input_tokens: z.number().nonnegative().optional(),
  cache_creation_input_tokens: z.number().nonnegative().optional(),
});
const blocksSchema = z.array(z.looseObject({ type: z.string() }));
const modelUsageSchema = z.record(
  z.string(),
  z.looseObject({ contextWindow: z.number() }),
);
const retrySchema = z.object({
  attempt: z.number(),
  max_retries: z.number(),
  retry_delay_ms: z.number(),
  error_status: z.number().nullable(),
  error: z.string(),
});
const taskUsageSchema = z
  .object({
    total_tokens: z.number(),
    tool_uses: z.number(),
    duration_ms: z.number(),
  })
  .transform((usage) => ({
    totalTokens: usage.total_tokens,
    toolUses: usage.tool_uses,
    durationMs: usage.duration_ms,
  }));
const taskStatusSchema = z
  .enum(["pending", "running", "completed", "failed", "killed", "paused"])
  .optional();
const taskEndSchema = z.enum(["completed", "failed", "stopped"]);

function blocksOf(message: unknown) {
  const content = fields.safeParse(message).data?.content;
  return blocksSchema.safeParse(content).data ?? [];
}

function tokens(value: number | undefined) {
  const valid = value !== undefined && Number.isFinite(value) && value >= 0;
  return valid ? value : 0;
}

export function contextWindowHint(model: string): number | null {
  const large = LARGE_CONTEXT_MODELS.split(" ").includes(model);
  if (large || model.endsWith("[1m]")) return 1_000_000;
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

function httpCategory(status: number) {
  if (status === 402) return "billing";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate-limit";
  if (status === 529) return "overloaded";
  if (status >= 400 && status < 500) return "bad-request";
  return status >= 500 && status < 600 ? "internal" : "unknown";
}

function errorInfo(
  status: number | null | undefined,
  code: string | undefined,
  subtype?: string,
): ProviderErrorInfo | undefined {
  const httpStatusCode = status ?? null;
  const fromCode = ERRORS[code ?? ""];
  const fromStatus =
    httpStatusCode === null ? undefined : httpCategory(httpStatusCode);
  const fromSubtype = ERRORS[subtype ?? ""];
  const overloaded = fromCode !== undefined && httpStatusCode === 529;
  const mapped = fromCode === "unknown" ? fromStatus : (fromCode ?? fromStatus);
  const category = overloaded ? "overloaded" : (mapped ?? fromSubtype);
  const providerCode = code ?? (fromSubtype && subtype) ?? null;
  const empty = !category && providerCode === null && httpStatusCode === null;
  if (empty) return undefined;
  return { category: category ?? "unknown", providerCode, httpStatusCode };
}

export class ClaudeTranslator {
  private turn: Turn = { id: "", responded: false, compacting: false };
  private total = ui.ZERO_TOKEN_USAGE;
  private contextWindow: number | null = null;
  private suppressed = false;
  private parentRef: string | undefined;
  private readonly tools = new Map<string, tools.ClassifiedTool>();
  private readonly tasks = new Map<string, Task>();
  private readonly plan: tools.TaskPlan = new Map();

  constructor(
    private readonly events: EventBuilder,
    private readonly context: tools.ToolContext,
  ) {}

  setModel(model: string) {
    this.contextWindow = contextWindowHint(model);
  }

  acceptInput() {
    this.suppressed = false;
  }

  stopTasks() {
    for (const task of this.tasks.values()) {
      const { taskStatus } = task.item;
      const live = itemStatus(taskStatus) === "pending";
      if (!task.done) this.closeTask(task, live ? "stopped" : taskStatus);
    }
  }

  handle(raw: unknown) {
    const message = fields.safeParse(raw).data;
    if (message === undefined) return;
    this.parentRef = str(message.parent_tool_use_id) || undefined;
    const { type, subtype } = message;
    const translated = this.dispatch(message, str(type));
    if (!translated) ui.debug("dropped claude %s %s", type, subtype ?? "");
  }

  private dispatch(message: Json, type = "unknown"): boolean {
    if (type === "assistant") return this.assistant(message);
    if (type === "user") return this.user(message);
    if (type === "stream_event") return this.stream(message);
    if (type === "result") return this.result(message);
    const reset = type === "conversation_reset" && !this.blocked();
    if (reset) this.ensureTurn();
    if (reset) this.events.cleared();
    if (type !== "system") return type === "conversation_reset";
    return this.system(message, str(message.subtype) ?? "");
  }

  private blocked() {
    return this.suppressed && this.events.activeTurnId === null;
  }

  private activeTurn(): Turn | null {
    const id = this.events.activeTurnId;
    if (id === null) return null;
    if (this.turn.id !== id) {
      this.turn = { id, responded: false, compacting: false };
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
    const blocking = ({ done, item }: Task) =>
      !done && !item.skipTranscript && isBackgroundAgentTaskType(item.taskType);
    return [...this.tasks.values()].some(blocking);
  }

  private say(channel: "thinking" | "assistant", value: string, final = true) {
    const key = { channel, parentRef: this.parentRef };
    const kind = channel === "thinking" ? "reasoningText" : "agentMessage";
    if (final) this.events.textClose(key, kind, value);
    else this.events.delta(key, kind, value);
  }

  private planSteps(steps: PlanStep[]) {
    const active = steps.find((step) => step.status === "active")?.step;
    const presentation = { ...ui.labels.planSteps(active), suppress: true };
    const options = { status: "completed" as const, presentation };
    const key = { channel: "planSteps", parentRef: this.parentRef };
    this.events.closeItem(key, { type: "planSteps", steps }, options);
  }

  private reportContext(
    usedTokens: number | null,
    modelContextWindow: number | null,
    openTurnOnly: boolean,
  ) {
    const usage = { usedTokens, modelContextWindow, estimated: true };
    this.events.contextWindow(usage, undefined, openTurnOnly);
  }

  private assistant(message: Json): boolean {
    if (this.blocked()) return true;
    const { parentRef, events } = this;
    const body = fields.safeParse(message.message).data ?? {};
    const content = blocksOf(body);
    const texts = content.filter((block) => block.type === "text");
    const said = texts.flatMap((block) => str(block.text) ?? []).join("\n");
    const reply = said.trim();
    const usage = usageSchema.safeParse(body.usage).data;
    const top = parentRef === undefined;
    const silent =
      body.model === "<synthetic>" && reply === "No response requested.";
    if (silent && events.activeTurnId === null) return true;
    const turn = this.ensureTurn();
    if (top) turn.checkpoint = str(message.uuid) || turn.checkpoint;
    if (silent) {
      const checkpointId = turn.checkpoint;
      const settled = !this.hasBlockingTasks();
      if (settled) events.closeTurn({ status: "completed", checkpointId });
      return true;
    }
    if (top && usage !== undefined) {
      turn.requestTokens =
        tokens(usage.input_tokens) +
        tokens(usage.cache_read_input_tokens) +
        tokens(usage.cache_creation_input_tokens);
      this.reportContext(turn.requestTokens, this.contextWindow, true);
    }
    for (const block of content) {
      const thinking = block.type === "thinking" && str(block.thinking);
      if (thinking) this.say("thinking", thinking);
    }
    if (reply) this.say("assistant", reply);
    for (const block of content) {
      const [id, name] = [str(block.id), str(block.name)];
      const use = block.type === "tool_use" && id !== undefined;
      if (!use || name === undefined) continue;
      const tool = tools.classifyTool(name, id, block.input, this.context);
      this.tools.set(id, tool);
      const { presentation, planSteps } = tool;
      const key = { providerItemId: id, parentRef };
      events.openItem(key, tool.shape, { presentation });
      if (planSteps !== undefined) this.planSteps(planSteps);
    }
    return true;
  }

  private stream(message: Json): boolean {
    const event = fields.safeParse(message.event).data ?? {};
    const delta = event.type === "content_block_delta";
    const start = event.type === "content_block_start";
    const part = fields.safeParse(delta ? event.delta : event.content_block);
    if ((!delta && !start) || part.data === undefined) return true;
    const suffix = delta ? "_delta" : "";
    const { type, thinking, text } = part.data;
    const thought = type === `thinking${suffix}` && str(thinking);
    const said = type === `text${suffix}` && str(text);
    if ((!thought && !said) || this.blocked()) return true;
    this.ensureTurn();
    if (thought) this.say("thinking", thought, false);
    if (said) this.say("assistant", said, false);
    return true;
  }

  private user(message: Json): boolean {
    const { parentRef } = this;
    const blocks = blocksOf(message.message);
    const results = blocks.filter(
      (block) => block.type === "tool_result" && str(block.tool_use_id),
    );
    const turn = this.activeTurn();
    if (results.length === 0) {
      const nested = message.parent_tool_use_id != null;
      const prompt = message.isSynthetic !== true && !nested;
      if (turn !== null && prompt) turn.checkpoint ??= str(message.uuid);
      const narrated = blocks.every((block) => block.type === "text");
      return blocks.length > 0 && narrated;
    }
    if (turn === null) return false;
    const envelope = results.length === 1 ? message.tool_use_result : undefined;
    for (const block of results) {
      const id = str(block.tool_use_id) ?? "";
      const toolName = str(block.tool_name);
      const started = this.tools.get(id);
      this.tools.delete(id);
      const base =
        started ?? tools.genericTool(toolName ?? "unknown", undefined);
      const failed = block.is_error === true;
      const output = tools.toolOutput(base.shape, toolName, block.content);
      const shape = tools.completedShape(base.shape, output, failed);
      const status = failed ? "failed" : "completed";
      const { presentation } = base;
      const key = { providerItemId: id, parentRef };
      this.events.closeItem(key, shape, { status, presentation });
      const call = started?.shape.type === "toolCall" ? started.shape : null;
      const tool = call?.tool ?? toolName;
      if (failed || tool === undefined) continue;
      const reported = envelope ?? output;
      const input = call?.arguments;
      const steps = tools.foldTaskResult(this.plan, tool, input, reported);
      if (steps !== null) this.planSteps(steps);
    }
    return true;
  }

  private result(message: Json): boolean {
    const subtype = str(message.subtype);
    const turn = this.activeTurn();
    const origin = str(fields.safeParse(message.origin).data?.kind) ?? "human";
    const settles = turn?.responded === true || origin === "human";
    if (subtype === undefined || turn === null || !settles) return true;
    turn.responded = true;
    const reported = reportedContextWindow(message.modelUsage);
    const window = reported ?? this.contextWindow;
    const used = turn.requestTokens ?? null;
    this.contextWindow = window;
    const measured = used !== null || window !== null;
    if (measured) this.reportContext(used, window, true);
    const usage = usageSchema.safeParse(message.usage).data;
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
      const { total } = this;
      this.events.usage({ total, last, modelContextWindow: reported });
    }
    const failed = message.is_error === true || subtype.startsWith("error");
    if (failed) {
      const status = z.number().safeParse(message.api_error_status).data;
      const listed = z.array(z.string()).safeParse(message.errors).data ?? [];
      const errors = listed.map((entry) => entry.trim()).filter(Boolean);
      const generic = `Claude Code result failed: ${subtype}`;
      const stated = message.is_error === true ? str(message.result) : null;
      const detail = stated ?? (errors.join("\n") || generic);
      const info = errorInfo(status, undefined, subtype);
      this.events.error({ detail, errorInfo: info });
    } else if (this.hasBlockingTasks()) {
      return true;
    }
    this.suppressed = failed;
    const checkpointId = turn.checkpoint;
    const status = failed ? "failed" : "completed";
    this.events.closeTurn({ status, checkpointId });
    return true;
  }

  private system(message: Json, subtype: string): boolean {
    const { events, turn } = this;
    const from = str(message.original_model);
    const to = str(message.fallback_model);
    const compaction = { type: "contextCompaction" as const };
    const key = { channel: "compaction" };
    const presentation = ui.labels.compaction;
    const retry = retrySchema.safeParse(message).data;
    if (subtype === "api_retry" && retry !== undefined) {
      const status = retry.error_status;
      const http = status === null ? "" : ` HTTP ${status}`;
      const attempt = `${retry.attempt}/${retry.max_retries}`;
      const detail = `Claude Code API retry ${attempt} after ${retry.retry_delay_ms}ms:${http} ${retry.error}`;
      const threadScoped = this.blocked();
      if (!threadScoped) this.ensureTurn();
      const info = errorInfo(status, retry.error);
      const report = { detail, willRetry: true, errorInfo: info };
      events.error(report, { threadScoped });
      return true;
    }
    if (subtype === "status" && message.status === "compacting") {
      if (this.blocked()) return true;
      this.ensureTurn().compacting = true;
      events.openItem(key, compaction, { presentation });
    } else if (subtype === "status") {
      const wasCompacting = turn.compacting;
      turn.compacting = false;
      if (!wasCompacting || this.activeTurn() !== turn) return true;
      events.closeItem(key, compaction, { status: "completed", presentation });
    } else if (subtype === "compact_boundary") {
      events.compacted();
      this.reportContext(null, null, false);
    } else if (/^model_(refusal_)?fallback$/.test(subtype) && from && to) {
      const fallback = `${from}\u0000${to}`;
      if (turn.fallback === fallback) return true;
      turn.fallback = fallback;
      const transition = { originalModel: from, fallbackModel: to };
      const refused = subtype === "model_refusal_fallback";
      const reason = refused ? ("refusal" as const) : ("provider" as const);
      const note = str(message.content) ?? `Switched from ${from} to ${to}.`;
      events.modelFallback({ ...transition, reason, message: note });
    } else {
      return this.task(message, subtype);
    }
    return true;
  }

  private taskPresentation(item: BackgroundTaskShape) {
    const { taskType, description, workflowName } = item;
    if (taskType === "local_workflow") {
      const title = workflowName ?? description;
      const completed = "Workflow finished";
      return ui.presentation("Running workflow", completed, "Workflow", title);
    }
    const command = taskType === "local_bash";
    const noun = command ? "command" : "agent";
    const glyph = command ? "Terminal" : "UserRound";
    const pending = `Running background ${noun}`;
    const completed = `Background ${noun} finished`;
    return ui.presentation(pending, completed, glyph, description);
  }

  private closeTask(task: Task, taskStatus: BackgroundTaskShape["taskStatus"]) {
    task.done = true;
    task.item = { ...task.item, taskStatus };
    const presentation = this.taskPresentation(task.item);
    const options = { status: itemStatus(taskStatus), presentation };
    this.events.closeItem(task.key, task.item, options);
  }

  private task(message: Json, subtype: string): boolean {
    const id = str(message.task_id);
    if (id === undefined) return false;
    const known = this.tasks.get(id);
    const usage = taskUsageSchema.safeParse(message.usage).data;
    const description = str(message.description);
    if (subtype === "task_started") {
      const taskType = str(message.task_type) ?? "unknown";
      const parentRef = str(message.tool_use_id);
      const orphan = parentRef !== undefined && !this.tools.has(parentRef);
      const fresh = known === undefined ? !orphan : known.done;
      const shown = TASK_TYPES.split(" ").includes(taskType);
      const start = shown && fresh && !this.blocked();
      if (!start || description === undefined) return false;
      const generation = (known?.generation ?? 0) + 1;
      const suffix = generation > 1 ? `#${generation}` : "";
      const key = { providerItemId: `task:${id}${suffix}`, parentRef };
      const item: BackgroundTaskShape = {
        type: "backgroundTask",
        familyId: id,
        taskType,
        description,
        taskStatus: "running",
        skipTranscript: message.skip_transcript === true,
        workflowName: str(message.workflow_name),
      };
      this.tasks.set(id, { key, generation, done: false, item });
      this.ensureTurn();
      const presentation = this.taskPresentation(item);
      this.events.openItem(key, item, { presentation });
      return true;
    }
    if (known === undefined || known.done) return false;
    const before = known.item;
    const progress = (shape: BackgroundTaskShape) => {
      known.item = shape;
      const snapshot = { shape, status: itemStatus(shape.taskStatus) };
      const flush = shape.taskStatus !== before.taskStatus;
      this.events.progress(known.key, { snapshot, flush });
      return true;
    };
    const patch = fields.safeParse(message.patch).data;
    const patched = taskStatusSchema.safeParse(patch?.status);
    const ended = taskEndSchema.safeParse(message.status).data;
    const [summary, file] = [message.summary, message.output_file].map(str);
    if (subtype === "task_progress" && usage && description !== undefined) {
      return progress({ ...before, usage });
    }
    if (subtype === "task_updated" && patch && patched.success) {
      const taskStatus = patched.data ?? before.taskStatus;
      const renamed = str(patch.description) ?? before.description;
      const error = str(patch.error) ?? before.error;
      return progress({ ...before, taskStatus, description: renamed, error });
    }
    const finished = summary !== undefined && file !== undefined;
    if (subtype !== "task_notification" || !ended || !finished) return false;
    known.item = { ...before, summary, usage: usage ?? before.usage };
    if (file !== "") known.item.outputFile = file;
    this.closeTask(known, ended);
    return true;
  }
}
