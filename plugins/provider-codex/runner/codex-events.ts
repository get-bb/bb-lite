import {
  fromProviderExternalThreadName as threadName,
  type ProviderErrorCategory,
  type ThreadEventItemPresentation as Presentation,
} from "@bb/domain";
import { z } from "zod";
import type {
  EventBuilder,
  ItemShape,
  OutputChannel,
  TextChannel,
} from "@bb/runner";
import * as ui from "@bb/runner";

const text = z.string();
const texts = z.array(text);
const count = z.number();
const maybeCount = count.nullable();
const itemStatus = z.enum(["inProgress", "completed", "failed", "declined"]);
const scoped = { threadId: text, turnId: text };
const item = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), ...shape });
const errorSchema = z.object({
  message: text,
  codexErrorInfo: z.unknown().optional(),
  additionalDetails: text.nullish(),
});
export const turnSchema = z.object({
  id: text,
  status: z.enum(["completed", "failed", "interrupted", "inProgress"]),
  error: errorSchema.nullish(),
});
const usageSchema = z.object({
  totalTokens: count,
  inputTokens: count,
  cachedInputTokens: count.nonnegative(),
  cacheWriteInputTokens: count.nonnegative().optional(),
  outputTokens: count,
  reasoningOutputTokens: count,
});
const contentItem = z.object({
  text: text.optional(),
  imageUrl: text.optional(),
});
const changeKind = z.enum(["add", "delete", "update"]);
const fileChange = z.object({
  path: text,
  diff: text,
  kind: z.object({ type: changeKind, move_path: text.nullish() }),
});
const webAction = z.object({
  type: text,
  query: text.nullish(),
  queries: texts.nullish(),
  url: text.nullish(),
  pattern: text.nullish(),
});
const command = { command: text, cwd: text, aggregatedOutput: text.nullable() };
const timed = { status: itemStatus, durationMs: maybeCount };
const call = { ...timed, tool: text, arguments: z.unknown().optional() };
const toolError = z.object({ message: text.optional() }).nullish();
const dynamicResult = { contentItems: z.array(contentItem).nullable() };
const collabRouting = { senderThreadId: text, receiverThreadIds: texts };
const collabDetail = { prompt: text.nullable(), model: text.nullable() };
const collabState = { agentsStates: z.record(text, z.unknown()) };
const activityKind = z.enum([
  "started",
  "interacted",
  "interrupted",
  "completed",
]);
const itemSchema = z.discriminatedUnion("type", [
  item("agentMessage", { text }),
  item("userMessage", {}),
  item("plan", { text }),
  item("contextCompaction", {}),
  item("imageView", { path: text }),
  item("reasoning", { summary: texts, content: texts }),
  item("commandExecution", { ...command, ...timed, exitCode: maybeCount }),
  item("fileChange", { status: itemStatus, changes: z.array(fileChange) }),
  item("mcpToolCall", { ...call, server: text, error: toolError }),
  item("dynamicToolCall", {
    ...call,
    ...dynamicResult,
    success: z.boolean().nullable(),
  }),
  item("collabAgentToolCall", {
    ...collabRouting,
    ...collabDetail,
    ...collabState,
    tool: text,
    status: itemStatus,
    reasoningEffort: text.nullable(),
  }),
  item("subAgentActivity", {
    kind: activityKind,
    agentThreadId: text,
    agentPath: text,
  }),
  item("webSearch", { query: text, action: webAction.nullable() }),
]);
type CodexItem = z.infer<typeof itemSchema>;
type Agent = Extract<CodexItem, { type: "subAgentActivity" }>;
type Turn = z.infer<typeof turnSchema>;

const rawItem = z.looseObject({ type: text, id: text });
const itemEvent = z.object({ ...scoped, item: rawItem });
const deltaEvent = z.object({ ...scoped, itemId: text, delta: text });
const turnEvent = z.object({ threadId: text, turn: turnSchema });
const threadEvent = z.object({ id: text.min(1), preview: text.optional() });
const nameEvent = z.object({ threadId: text, threadName: text.optional() });
const progressEvent = z.object({
  ...scoped,
  itemId: text,
  message: text.optional(),
});
const warningEvent = z.object({ summary: text, details: text.nullish() });
const usageEvent = z.object({
  turnId: text,
  tokenUsage: z.object({
    total: usageSchema,
    last: usageSchema,
    modelContextWindow: maybeCount,
  }),
});
const stepStatus = z.enum(["pending", "inProgress", "completed", "failed"]);
const planEvent = z.object({
  turnId: text,
  plan: z.array(z.object({ step: text, status: stepStatus })),
  explanation: text.nullish(),
});
const failureEvent = z.object({
  threadId: text,
  turnId: text.optional(),
  error: errorSchema,
  willRetry: z.boolean().optional(),
});
const goalSchema = z.object({
  objective: text,
  status: z.enum(["active", "paused", "budgetLimited", "complete"]),
  tokenBudget: maybeCount,
  tokensUsed: count,
  timeUsedSeconds: count,
});

const DELTA_CHANNELS: Record<string, TextChannel | OutputChannel> = {
  "item/agentMessage/delta": "agentMessage",
  "item/reasoning/summaryTextDelta": "reasoningSummary",
  "item/reasoning/textDelta": "reasoningText",
  "item/plan/delta": "plan",
  "item/commandExecution/outputDelta": "command",
  "item/fileChange/outputDelta": "fileChange",
};
const STATUS = {
  inProgress: "pending",
  completed: "completed",
  failed: "failed",
  declined: "interrupted",
} as const;
const ERROR_CATEGORY: Record<string, ProviderErrorCategory> = {
  contextWindowExceeded: "context-window-exceeded",
  sessionBudgetExceeded: "budget-exceeded",
  usageLimitExceeded: "rate-limit",
  serverOverloaded: "overloaded",
  cyberPolicy: "policy",
  misalignmentPolicyViolation: "policy",
  internalServerError: "internal",
  unauthorized: "unauthorized",
  badRequest: "bad-request",
  threadRollbackFailed: "thread-rollback-failed",
  sandboxError: "sandbox",
  httpConnectionFailed: "connection-failed",
  responseStreamConnectionFailed: "connection-failed",
  responseStreamDisconnected: "stream-disconnected",
  responseTooManyFailedAttempts: "too-many-failed-attempts",
  activeTurnNotSteerable: "active-turn-not-steerable",
};
const COLLAB_LABELS: Record<string, [string, string, string]> = {
  spawnAgent: ["Spawning agent", "Spawned agent", "Spawn agent"],
  wait: ["Waiting for agents", "Waited for agents", "Wait for agent"],
  resumeAgent: ["Resuming agent", "Resumed agent", "Resume agent"],
  sendInput: ["Messaging agent", "Messaged agent", "Send input to agent"],
  closeAgent: ["Closing agent", "Closed agent", "Close agent"],
};
const GOAL_KIND = "provider-codex/goal";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorInfo(info: unknown) {
  if (info === null || info === undefined) return undefined;
  const providerCode = isRecord(info) ? Object.keys(info)[0] : String(info);
  const detail = isRecord(info) && providerCode ? info[providerCode] : null;
  const status = isRecord(detail) ? detail.httpStatusCode : null;
  const category = ERROR_CATEGORY[providerCode ?? ""] ?? ("unknown" as const);
  const httpStatusCode = typeof status === "number" ? status : null;
  return { category, providerCode: providerCode ?? null, httpStatusCode };
}

interface Translated {
  shape: ItemShape;
  label: Presentation;
  status: (typeof STATUS)[keyof typeof STATUS];
  denied: boolean;
}

function translateItem(
  raw: CodexItem,
  injected: Map<string, Presentation | undefined>,
): Translated | "ignored" | "unhandled" {
  const done = (
    shape: ItemShape,
    label: Presentation,
    status: keyof typeof STATUS = "completed",
  ) => ({
    shape,
    label,
    status: STATUS[status],
    denied: status === "declined",
  });
  const input = "arguments" in raw ? raw.arguments : undefined;
  const args = isRecord(input) ? input : undefined;
  const timing = "durationMs" in raw ? raw.durationMs : null;
  const durationMs = timing ?? undefined;
  const call = (tool: string, server: string | undefined) => {
    const shape = { type: "toolCall" as const, server, tool };
    return { ...shape, arguments: args };
  };
  switch (raw.type) {
    case "userMessage":
    case "subAgentActivity":
      return "ignored";
    case "agentMessage":
      return done(raw, ui.labels.message);
    case "reasoning":
      return done(raw, ui.labels.reasoning);
    case "plan":
      return done(raw, ui.labels.plan);
    case "contextCompaction":
      return done(raw, ui.labels.compaction);
    case "imageView":
      return done(raw, ui.labels.imageView(raw.path));
    case "commandExecution": {
      const { type, command: line, cwd, status } = raw;
      const aggregatedOutput = raw.aggregatedOutput ?? undefined;
      const result = { aggregatedOutput, exitCode: raw.exitCode ?? undefined };
      const shape = { type, command: line, cwd, ...result };
      return done({ ...shape, durationMs }, ui.labels.command(line), status);
    }
    case "fileChange": {
      const changes = raw.changes.map(({ path, kind, diff }) => ({
        path,
        kind: kind.type,
        movePath: (kind.type === "update" && kind.move_path) || undefined,
        diff: diff || undefined,
      }));
      const paths = changes.map((change) => change.path);
      const label = ui.labels.fileChange(paths);
      return done({ type: raw.type, changes }, label, raw.status);
    }
    case "mcpToolCall": {
      const { server, tool, status } = raw;
      const error = raw.error?.message;
      const label = ui.labels.tool(tool, server);
      return done({ ...call(tool, server), error, durationMs }, label, status);
    }
    case "dynamicToolCall": {
      const parts = (raw.contentItems ?? [])
        .map((c) => c.text ?? (c.imageUrl ? `[image: ${c.imageUrl}]` : ""))
        .filter((part) => part.trim().length > 0);
      const result = parts.length > 0 ? parts.join("\n") : undefined;
      const failed = raw.success === false;
      const error = failed ? (result ?? "Dynamic tool call failed") : undefined;
      const { tool, status } = raw;
      const shape = call(tool, injected.has(tool) ? "bb" : undefined);
      const label = injected.get(tool) ?? ui.labels.tool(tool);
      return done({ ...shape, result, error, durationMs }, label, status);
    }
    case "collabAgentToolCall": {
      const { tool, prompt, agentsStates, status, receiverThreadIds } = raw;
      const fallback = [`Running ${tool}`, `Ran ${tool}`, tool];
      const [pending, completed, verb] = COLLAB_LABELS[tool] ?? fallback;
      const title = prompt ?? undefined;
      const label = ui.presentation(pending, completed, "UserRound", title);
      const [childRef] = receiverThreadIds;
      if (childRef) {
        const states = Object.entries(agentsStates).map(([id, state]) => {
          const value =
            typeof state === "string" ? state : JSON.stringify(state);
          return `${id}: ${value}`;
        });
        const settled = status !== "inProgress" && states.length > 0;
        const summary = settled ? states.join("\n") : undefined;
        const name = prompt?.trim() || verb;
        const agent = { type: "delegation" as const, childRef, label: name };
        return done({ ...agent, background: false, summary }, label, status);
      }
      const input = {
        senderThreadId: raw.senderThreadId,
        receiverThreadIds,
        ...(prompt ? { prompt } : {}),
        ...(raw.model ? { model: raw.model } : {}),
        ...(raw.reasoningEffort
          ? { reasoningEffort: raw.reasoningEffort }
          : {}),
      };
      const shape = { type: "toolCall" as const, tool, arguments: input };
      return done({ ...shape, result: agentsStates }, label, status);
    }
    case "webSearch": {
      const { action } = raw;
      if (action === null || action.type === "other") return "ignored";
      const resultText = null;
      if (action.type === "search") {
        const candidates = [...(action.queries ?? []), action.query, raw.query];
        const queries = [...new Set(candidates.flatMap((q) => (q ? [q] : [])))];
        if (queries.length === 0) return "unhandled";
        const label = ui.labels.webSearch(queries[0]);
        return done({ type: raw.type, queries, resultText }, label);
      }
      const { url } = action;
      if (!url) return "unhandled";
      const found = action.type === "findInPage" ? action.pattern : null;
      const page = { type: "webFetch" as const, url, prompt: null, resultText };
      const label = ui.labels.webFetch(url);
      return done({ ...page, pattern: found ?? null }, label);
    }
  }
}

interface TrackedAgent {
  callId: string;
  agentThreadId: string;
  agentPath: string;
  turn: string;
  parentRef: string | undefined;
  open: boolean;
}

export interface CodexTranslatorHooks {
  rootThreadId(): string | null;
  onTerminalError(category: ProviderErrorCategory, detail: string): void;
}

export class CodexTranslator {
  private retryErrors = new Map<string, { info: unknown; text: string }>();
  private agents = new Map<string, TrackedAgent>();
  private parentByThread = new Map<string, string>();
  private parentByTurn = new Map<string, string>();

  constructor(
    private readonly events: EventBuilder,
    private readonly injected: Map<string, Presentation | undefined>,
    private readonly hooks: CodexTranslatorHooks,
    private awaitingReplayedUsage: boolean,
  ) {}

  handle(method: string, params: unknown) {
    if (!this.dispatch(method, params)) ui.debug("dropped codex %s", method);
  }

  openTurn(threadId: string, turn: string) {
    this.awaitingReplayedUsage = false;
    const agent = this.agentOf(threadId);
    if (agent && !agent.open) this.setAgent(agent, "pending");
    const parentRef = this.parentRef(threadId, turn);
    if (parentRef !== undefined) this.parentByTurn.set(turn, parentRef);
    this.events.openTurn({ turn, parentRef });
  }

  closeTurn(threadId: string, { id: turn, status: reported, error }: Turn) {
    this.retryErrors.delete(`${threadId}\0${turn}`);
    const status = reported === "inProgress" ? "completed" : reported;
    const message = error?.message || undefined;
    const outcome = { status, error: message, checkpointId: turn };
    this.events.closeTurn({ turn, ...outcome });
    const agent = this.agents.get(this.parentByTurn.get(turn) ?? "");
    if (agent?.open) this.setAgent(agent, status);
  }

  closeAgents(threadId?: string) {
    const open = [...this.agents.values()].filter(
      (a) => a.open && (threadId === undefined || a.agentThreadId === threadId),
    );
    for (const agent of open) this.setAgent(agent, "failed");
    return open.length > 0;
  }

  private parentRef(threadId: string, turn: string) {
    return this.parentByTurn.get(turn) ?? this.parentByThread.get(threadId);
  }

  private agentOf(threadId: string) {
    const agents = [...this.agents.values()];
    return agents.find((agent) => agent.agentThreadId === threadId);
  }

  private setAgent(
    agent: TrackedAgent,
    status: "pending" | "completed" | "failed" | "interrupted",
  ) {
    agent.open = status === "pending";
    const { callId, parentRef, turn, agentPath: label } = agent;
    const key = { providerItemId: callId, parentRef };
    const delegation = { type: "delegation" as const, label };
    const child = { background: false, childRef: agent.agentThreadId };
    const shape = { ...delegation, ...child };
    const options = { turn, presentation: ui.labels.agent(label) };
    if (status === "pending") this.events.openItem(key, shape, options);
    else this.events.closeItem(key, shape, { ...options, status });
  }

  private activity(
    threadId: string,
    turn: string,
    callId: string,
    item: Agent,
  ) {
    const { agentThreadId, agentPath, kind } = item;
    const tracked = this.agentOf(agentThreadId);
    if (kind === "interrupted" && tracked?.open) {
      this.setAgent(tracked, "interrupted");
    }
    if (kind !== "started" || this.agents.has(callId)) return;
    const parentRef = this.parentRef(threadId, turn);
    const state = { callId, agentThreadId, agentPath, turn, parentRef };
    const agent = { ...state, open: false };
    this.agents.set(callId, agent);
    this.parentByThread.set(agentThreadId, callId);
    this.setAgent(agent, "pending");
  }

  private item(method: string, params: unknown) {
    const envelope = itemEvent.safeParse(params);
    if (!envelope.success) return false;
    const { threadId, turnId: turn, item: raw } = envelope.data;
    const parsed = itemSchema.safeParse(raw);
    const closing = method === "item/completed";
    const parentRef = this.parentRef(threadId, turn);
    if (parsed.success && parsed.data.type === "subAgentActivity") {
      if (closing) this.activity(threadId, turn, raw.id, parsed.data);
      return true;
    }
    const translated = parsed.success
      ? translateItem(parsed.data, this.injected)
      : "unhandled";
    if (translated === "ignored") return true;
    if (translated === "unhandled") return false;
    const key = { providerItemId: raw.id, parentRef };
    const { shape, label: presentation, status, denied } = translated;
    if (shape.type === "delegation" && shape.childRef !== threadId) {
      this.parentByThread.set(shape.childRef, raw.id);
    }
    const options = { turn, presentation, status, denied };
    if (closing) this.events.closeItem(key, shape, options);
    else this.events.openItem(key, shape, options);
    return true;
  }

  private delta(method: string, params: unknown) {
    const channel = DELTA_CHANNELS[method];
    const parsed = deltaEvent.safeParse(params);
    if (!parsed.success || channel === undefined) return false;
    const { threadId, turnId: turn, itemId, delta } = parsed.data;
    const parentRef = this.parentRef(threadId, turn);
    const key = { providerItemId: itemId, parentRef };
    this.events.delta(key, channel, delta, { turn });
    return true;
  }

  private failure(data: z.infer<typeof failureEvent>) {
    const { threadId, turnId: turn, error, willRetry } = data;
    const failure = error.additionalDetails ?? error.message;
    const key = `${threadId}\0${turn ?? ""}`;
    const retried = this.retryErrors.get(key);
    let info = error.codexErrorInfo;
    if (willRetry === true && info && info !== "other") {
      this.retryErrors.set(key, { info, text: failure });
    } else if (willRetry === false) {
      this.retryErrors.delete(key);
      const inherits = info === "other" && retried?.text === failure;
      if (inherits) info = retried.info;
    }
    const detail = [error.message, error.additionalDetails]
      .filter(Boolean)
      .join("\n");
    const classified = errorInfo(info);
    const threadScoped = turn === undefined;
    const report = { detail, willRetry, errorInfo: classified };
    this.events.error(report, { turn, threadScoped });
    const category = classified?.category ?? "unknown";
    if (willRetry !== true) this.hooks.onTerminalError(category, detail);
  }

  private usage({ turnId, tokenUsage }: z.infer<typeof usageEvent>) {
    const { modelContextWindow } = tokenUsage;
    const withCacheRead = (usage: z.infer<typeof usageSchema>) => ({
      ...usage,
      cacheReadInputTokens: usage.cachedInputTokens,
    });
    const total = withCacheRead(tokenUsage.total);
    const last = withCacheRead(tokenUsage.last);
    const turn = this.awaitingReplayedUsage ? undefined : turnId;
    if (turn) this.events.usage({ total, last, modelContextWindow }, { turn });
    const window = { usedTokens: last.totalTokens, modelContextWindow };
    this.events.contextWindow({ ...window, estimated: false }, { turn });
  }

  private plan({ turnId: turn, plan, explanation }: z.infer<typeof planEvent>) {
    const steps = plan.map(({ step, status }) => ({
      step,
      status: status === "inProgress" ? ("active" as const) : status,
    }));
    const active = steps.find((step) => step.status === "active")?.step;
    const headline = active ?? explanation ?? undefined;
    const presentation = ui.labels.planSteps(headline);
    const shape = { type: "planSteps" as const, steps };
    const options = { turn, status: "completed" as const, presentation };
    const item = { ...shape, explanation: explanation || undefined };
    this.events.closeItem({ channel: "planSteps" }, item, options);
  }

  private dispatch(method: string, params: unknown): boolean {
    const { events, hooks } = this;
    const read = <S extends z.ZodType>(
      schema: S,
      run: (data: z.infer<S>) => unknown,
    ) => {
      const parsed = schema.safeParse(params);
      if (parsed.success) run(parsed.data);
      return parsed.success;
    };
    const isRoot = (threadId: string) => {
      const root = hooks.rootThreadId();
      return root === null || root === threadId;
    };
    switch (method) {
      case "item/started":
      case "item/completed":
        return this.item(method, params);
      case "turn/started":
        return read(turnEvent, (p) => this.openTurn(p.threadId, p.turn.id));
      case "turn/completed":
        return read(turnEvent, (p) => this.closeTurn(p.threadId, p.turn));
      case "thread/started":
        return read(z.object({ thread: threadEvent }), ({ thread }) => {
          if (!isRoot(thread.id)) return;
          events.started();
          events.identity(thread.id);
          if (thread.preview) events.name(threadName(thread.preview));
        });
      case "thread/name/updated":
        return read(nameEvent, ({ threadId, threadName: name }) => {
          if (isRoot(threadId) && name) events.name(threadName(name));
        });
      case "thread/compacted":
        return read(z.object(scoped), ({ turnId: turn }) =>
          events.compacted({ turn }),
        );
      case "thread/goal/updated":
        return read(z.object({ goal: goalSchema }), ({ goal }) =>
          events.extensionState(GOAL_KIND, goal),
        );
      case "thread/goal/cleared":
        events.extensionState(GOAL_KIND, null);
        return true;
      case "thread/closed": {
        const closed = z.object({ threadId: text }).safeParse(params);
        return closed.success && this.closeAgents(closed.data.threadId);
      }
      case "item/mcpToolCall/progress":
        return read(progressEvent, ({ threadId, turnId: turn, ...rest }) => {
          const parentRef = this.parentRef(threadId, turn);
          const key = { providerItemId: rest.itemId, parentRef };
          events.progress(key, { turn, message: rest.message || undefined });
        });
      case "thread/tokenUsage/updated":
        return read(usageEvent, (data) => this.usage(data));
      case "turn/plan/updated":
        return read(planEvent, (data) => this.plan(data));
      case "error":
        return read(failureEvent, (data) => this.failure(data));
      case "deprecationNotice":
      case "configWarning": {
        const category = method === "configWarning" ? "config" : "deprecation";
        return read(warningEvent, ({ summary, details }) =>
          events.warning({ category, summary, details: details || undefined }),
        );
      }
      case "warning":
        return read(z.object({ message: text }), ({ message: summary }) =>
          events.warning({ summary }),
        );
      default:
        return this.delta(method, params);
    }
  }
}
