import {
  fromProviderExternalThreadName,
  providerRawEventSchema,
  type ProviderErrorCategory,
  type ProviderRateLimitState,
  type ProviderRateLimitStatus,
  type ProviderRateLimitWindow,
  type ProviderRawEvent,
  type ThreadEventItemPresentation as Presentation,
} from "@bb/domain";
import { z } from "zod";
import type { EventBuilder, ItemShape } from "../events/event-builder.js";
import {
  AGENT_MESSAGE_PRESENTATION,
  COMPACTION_PRESENTATION,
  PLAN_PRESENTATION,
  REASONING_PRESENTATION,
  agentPresentation,
  commandPresentation,
  fileChangePresentation,
  imageViewPresentation,
  planStepsPresentation,
  presentation,
  presentationFileName,
  toolPresentation,
  webFetchPresentation,
  webSearchPresentation,
} from "./provider.js";

const text = z.string();
const nullableNumber = z.number().nullable();
const itemStatus = z.enum(["inProgress", "completed", "failed", "declined"]);
const scoped = { threadId: text, turnId: text };
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
  totalTokens: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number().nonnegative(),
  cacheWriteInputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
});
const windowSchema = z.object({
  usedPercent: z.number(),
  windowDurationMins: z.number().nullish(),
  resetsAt: z.number().nullish(),
});
const rateLimitSchema = z.object({
  limitId: text.nullish(),
  primary: windowSchema.nullish(),
  secondary: windowSchema.nullish(),
  credits: z
    .object({ hasCredits: z.boolean(), unlimited: z.boolean() })
    .nullish(),
  individualLimit: z
    .object({ remainingPercent: z.number(), resetsAt: z.number() })
    .nullish(),
  spendControlReached: z.boolean().nullish(),
  rateLimitReachedType: text.nullish(),
});
type RateLimits = z.infer<typeof rateLimitSchema>;
const contentItem = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inputText"), text }),
  z.object({ type: z.literal("inputImage"), imageUrl: text }),
]);
const fileChange = z.object({
  path: text,
  diff: text,
  kind: z.object({
    type: z.enum(["add", "delete", "update"]),
    move_path: text.nullish(),
  }),
});
const webAction = z.object({
  type: text,
  query: text.nullish(),
  queries: z.array(text).nullish(),
  url: text.nullish(),
  pattern: text.nullish(),
});
const itemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agentMessage"), text }),
  z.object({ type: z.literal("userMessage") }),
  z.object({ type: z.literal("plan"), text }),
  z.object({ type: z.literal("contextCompaction") }),
  z.object({ type: z.literal("imageView"), path: text }),
  z.object({
    type: z.literal("reasoning"),
    summary: z.array(text),
    content: z.array(text),
  }),
  z.object({
    type: z.literal("commandExecution"),
    command: text,
    cwd: text,
    status: itemStatus,
    aggregatedOutput: text.nullable(),
    exitCode: nullableNumber,
    durationMs: nullableNumber,
  }),
  z.object({
    type: z.literal("fileChange"),
    status: itemStatus,
    changes: z.array(fileChange),
  }),
  z.object({
    type: z.literal("mcpToolCall"),
    server: text,
    tool: text,
    status: itemStatus,
    arguments: z.unknown().optional(),
    error: z.object({ message: text.optional() }).nullish(),
    durationMs: nullableNumber,
  }),
  z.object({
    type: z.literal("dynamicToolCall"),
    tool: text,
    arguments: z.unknown().optional(),
    status: itemStatus,
    contentItems: z.array(contentItem).nullable(),
    success: z.boolean().nullable(),
    durationMs: nullableNumber,
  }),
  z.object({
    type: z.literal("collabAgentToolCall"),
    tool: text,
    status: itemStatus,
    senderThreadId: text,
    receiverThreadIds: z.array(text),
    prompt: text.nullable(),
    model: text.nullable(),
    reasoningEffort: text.nullable(),
    agentsStates: z.record(text, z.unknown()),
  }),
  z.object({
    type: z.literal("subAgentActivity"),
    kind: z.enum(["started", "interacted", "interrupted", "completed"]),
    agentThreadId: text,
    agentPath: text,
  }),
  z.object({
    type: z.literal("webSearch"),
    query: text,
    action: webAction.nullable(),
  }),
  z.object({
    type: z.literal("imageGeneration"),
    status: z.union([itemStatus, z.literal("in_progress")]),
    revisedPrompt: text.nullable(),
    result: text,
    transparentBackground: z.boolean().nullish(),
    failure: z.object({}).nullable(),
    savedPath: text.optional(),
  }),
]);
type CodexItem = z.infer<typeof itemSchema>;
type ItemStatus = z.infer<typeof itemStatus>;

const itemEvent = z.object({
  ...scoped,
  item: z.looseObject({ type: text, id: text }),
});
const deltaEvent = z.object({ ...scoped, itemId: text, delta: text });
const turnEvent = z.object({ threadId: text, turn: turnSchema });
const warningEvent = z.object({ summary: text, details: text.nullish() });
const goalSchema = z.object({
  objective: text,
  status: z.enum(["active", "paused", "budgetLimited", "complete"]),
  tokenBudget: nullableNumber,
  tokensUsed: z.number(),
  timeUsedSeconds: z.number(),
});

const NOISE = new Set([
  "item/autoApprovalReview/completed",
  "item/autoApprovalReview/started",
  "mcpServer/startupStatus/updated",
  "rawResponse/completed",
  "rawResponseItem/completed",
  "remoteControl/status/changed",
  "serverRequest/resolved",
  "skills/changed",
  "thread/archived",
  "thread/unarchived",
  "thread/settings/updated",
  "turn/diff/updated",
  "turn/moderationMetadata",
]);
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
const RANK = { unknown: 0, allowed: 1, warning: 2, blocked: 3 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorInfo(info: unknown) {
  if (info === null || info === undefined) return undefined;
  const providerCode = isRecord(info) ? Object.keys(info)[0] : String(info);
  const detail = isRecord(info) && providerCode ? info[providerCode] : null;
  const status = isRecord(detail) ? detail.httpStatusCode : null;
  return {
    category: ERROR_CATEGORY[providerCode ?? ""] ?? ("unknown" as const),
    providerCode: providerCode ?? null,
    httpStatusCode: typeof status === "number" ? status : null,
  };
}

function rawEvent(method: string, params: unknown): ProviderRawEvent {
  const base = { jsonrpc: "2.0" as const, method };
  const parsed = providerRawEventSchema.safeParse(
    params ? { ...base, params } : base,
  );
  return parsed.success ? parsed.data : base;
}

function windowStatus(usedPercent: number): ProviderRateLimitStatus {
  return usedPercent >= 100
    ? "blocked"
    : usedPercent >= 90
      ? "warning"
      : "allowed";
}

function reachedReasonActive(limits: RateLimits, reason: string) {
  if (reason === "rate_limit_reached") {
    return [limits.primary, limits.secondary].some(
      (w) => w && w.usedPercent >= 100,
    );
  }
  const { credits, individualLimit } = limits;
  if (reason.includes("credits_depleted")) {
    return Boolean(credits && !credits.unlimited && !credits.hasCredits);
  }
  const spent = individualLimit && individualLimit.remainingPercent <= 0;
  return reason.includes("usage_limit_reached") && Boolean(spent);
}

function mergeRateLimits(previous: RateLimits | undefined, update: RateLimits) {
  const merged: RateLimits = {
    primary: update.primary ?? previous?.primary,
    secondary: update.secondary ?? previous?.secondary,
    credits: update.credits ?? previous?.credits,
    individualLimit: update.individualLimit ?? previous?.individualLimit,
    spendControlReached: update.spendControlReached,
    rateLimitReachedType: update.rateLimitReachedType,
  };
  const earlier = previous?.rateLimitReachedType;
  const carried = !merged.rateLimitReachedType && earlier;
  if (carried && reachedReasonActive(merged, earlier)) {
    merged.rateLimitReachedType = earlier;
  }
  return merged;
}

function normalizeRateLimits(limits: RateLimits): ProviderRateLimitState {
  const windows: ProviderRateLimitWindow[] = [];
  for (const providerKey of ["primary", "secondary"] as const) {
    const window = limits[providerKey];
    if (!window) continue;
    const minutes = window.windowDurationMins;
    const weekly =
      minutes === 300
        ? false
        : minutes === 10_080 || providerKey === "secondary";
    const label = weekly ? "Weekly limit" : "Current session";
    const resetsAtMs = window.resetsAt == null ? null : window.resetsAt * 1_000;
    const status = windowStatus(window.usedPercent);
    windows.push({ providerKey, label, status, resetsAtMs });
  }
  const individual = limits.individualLimit;
  if (individual) {
    const status = windowStatus(100 - individual.remainingPercent);
    const resetsAtMs = individual.resetsAt * 1_000;
    const providerKey = "individual-limit";
    windows.push({ providerKey, label: "Spend control", status, resetsAtMs });
  }
  const reachedReason = limits.rateLimitReachedType ?? null;
  const spent = Boolean(individual && individual.remainingPercent <= 0);
  const windowed = Boolean(limits.primary || limits.secondary);
  const kind =
    reachedReason === "rate_limit_reached"
      ? "subscription-window"
      : reachedReason?.includes("credits_depleted")
        ? "credits"
        : reachedReason?.includes("usage_limit_reached")
          ? "spend-control"
          : reachedReason !== null
            ? "unknown"
            : spent || (!windowed && individual)
              ? "spend-control"
              : windowed
                ? "subscription-window"
                : "unknown";
  const worst = windows.reduce(
    (rank, window) => Math.max(rank, RANK[window.status]),
    windows.length > 0 || limits.credits?.hasCredits ? 1 : 0,
  );
  const status = reachedReason !== null ? "blocked" : STATUS_BY_RANK[worst];
  const capped = limits.spendControlReached === true;
  return {
    providerId: "codex",
    status: capped ? "blocked" : status,
    kind: capped ? "spend-control" : kind,
    windows,
    reachedReason,
    overageStatus: null,
    overageReason: null,
  };
}

const STATUS_BY_RANK: ProviderRateLimitStatus[] = [
  "unknown",
  "allowed",
  "warning",
  "blocked",
];

interface Translated {
  shape: ItemShape;
  presentation: Presentation;
  status: (typeof STATUS)[ItemStatus];
  denied: boolean;
}

function mcpPresentation(server: string, tool: string, args: unknown) {
  if (server === "node_repl" && tool === "js_reset") {
    const pending = "Resetting JavaScript session";
    return presentation(pending, "Reset JavaScript session", "Code");
  }
  if (server === "node_repl" && tool === "js") {
    const title =
      isRecord(args) && typeof args.title === "string" ? args.title : undefined;
    return presentation("Running JavaScript", "Ran JavaScript", "Code", title);
  }
  return toolPresentation(tool, server);
}

function translateItem(
  item: CodexItem,
  injected: Map<string, Presentation | undefined>,
): Translated | "ignored" | "unhandled" {
  const done = (
    shape: ItemShape,
    label: Presentation,
    status: ItemStatus = "completed",
  ): Translated => ({
    shape,
    presentation: label,
    status: STATUS[status],
    denied: status === "declined",
  });
  const args =
    "arguments" in item && isRecord(item.arguments)
      ? item.arguments
      : undefined;
  switch (item.type) {
    case "userMessage":
    case "subAgentActivity":
      return "ignored";
    case "agentMessage":
      return done(item, AGENT_MESSAGE_PRESENTATION);
    case "reasoning":
      return done(item, REASONING_PRESENTATION);
    case "plan":
      return done(item, PLAN_PRESENTATION);
    case "contextCompaction":
      return done(item, COMPACTION_PRESENTATION);
    case "imageView":
      return done(item, imageViewPresentation(item.path));
    case "commandExecution": {
      const { type, command, cwd, status } = item;
      const aggregatedOutput = item.aggregatedOutput ?? undefined;
      const exitCode = item.exitCode ?? undefined;
      const durationMs = item.durationMs ?? undefined;
      const shape = {
        type,
        command,
        cwd,
        aggregatedOutput,
        exitCode,
        durationMs,
      };
      return done(shape, commandPresentation(command), status);
    }
    case "fileChange": {
      const changes = item.changes.map(({ path, kind, diff }) => ({
        path,
        kind: kind.type,
        movePath: (kind.type === "update" && kind.move_path) || undefined,
        diff: diff || undefined,
      }));
      const paths = changes.map((change) => change.path);
      const shape = { type: item.type, changes };
      return done(shape, fileChangePresentation(paths), item.status);
    }
    case "mcpToolCall": {
      const { server, tool } = item;
      const error = item.error?.message;
      const durationMs = item.durationMs ?? undefined;
      const call = { type: "toolCall" as const, server, tool, arguments: args };
      const label = mcpPresentation(server, tool, item.arguments);
      return done({ ...call, error, durationMs }, label, item.status);
    }
    case "dynamicToolCall": {
      const parts = (item.contentItems ?? [])
        .map((c) =>
          c.type === "inputText" ? c.text : `[image: ${c.imageUrl}]`,
        )
        .filter((part) => part.trim().length > 0);
      const result = parts.length > 0 ? parts.join("\n") : undefined;
      const failed = item.success === false;
      const error = failed ? (result ?? "Dynamic tool call failed") : undefined;
      const { tool } = item;
      const server = injected.has(tool) ? "bb" : undefined;
      const durationMs = item.durationMs ?? undefined;
      const call = { type: "toolCall" as const, server, tool, arguments: args };
      const label = injected.get(tool) ?? toolPresentation(tool);
      return done({ ...call, result, error, durationMs }, label, item.status);
    }
    case "collabAgentToolCall": {
      const { tool, prompt, agentsStates, status } = item;
      const [pending, completed, verb] = COLLAB_LABELS[tool] ?? [
        `Running ${tool}`,
        `Ran ${tool}`,
        tool,
      ];
      const title = prompt ?? undefined;
      const label = presentation(pending, completed, "UserRound", title);
      const childRef = item.receiverThreadIds[0];
      if (childRef) {
        const states = Object.entries(agentsStates).map(
          ([id, state]) =>
            `${id}: ${typeof state === "string" ? state : JSON.stringify(state)}`,
        );
        const settled = status !== "inProgress" && states.length > 0;
        const summary = settled ? states.join("\n") : undefined;
        const name = prompt?.trim() || verb;
        const agent = { type: "delegation" as const, childRef, label: name };
        return done({ ...agent, background: false, summary }, label, status);
      }
      const { senderThreadId, receiverThreadIds } = item;
      const model = item.model || undefined;
      const reasoningEffort = item.reasoningEffort || undefined;
      const routing = {
        senderThreadId,
        receiverThreadIds,
        prompt: prompt || undefined,
      };
      const input = JSON.parse(
        JSON.stringify({ ...routing, model, reasoningEffort }),
      );
      const call = { type: "toolCall" as const, tool, arguments: input };
      return done({ ...call, result: agentsStates }, label, status);
    }
    case "webSearch": {
      const action = item.action;
      if (action === null || action.type === "other") return "ignored";
      if (action.type === "search") {
        const candidates = [
          ...(action.queries ?? []),
          action.query,
          item.query,
        ];
        const queries = [...new Set(candidates.filter((q) => q))] as string[];
        if (queries.length === 0) return "unhandled";
        const shape = { type: item.type, queries, resultText: null };
        return done(shape, webSearchPresentation(queries[0]));
      }
      if (!action.url) return "unhandled";
      const pattern =
        action.type === "findInPage" ? (action.pattern ?? null) : null;
      const fetch = {
        type: "webFetch" as const,
        url: action.url,
        prompt: null,
      };
      const shape = { ...fetch, pattern, resultText: null };
      return done(shape, webFetchPresentation(action.url));
    }
    case "imageGeneration": {
      const path = item.savedPath ?? null;
      const prompt = item.revisedPrompt;
      const title = path ? presentationFileName(path) : (prompt ?? undefined);
      const label = presentation(
        "Generating image",
        "Generated image",
        "Palette",
        title,
      );
      const error = item.failure
        ? "Image generation usage limit exceeded"
        : null;
      const transparentBackground = item.transparentBackground ?? false;
      const image = {
        type: item.type,
        prompt,
        path,
        error,
        transparentBackground,
      };
      const status = item.status === "in_progress" ? "inProgress" : item.status;
      return done(
        { ...image, result: item.result || undefined },
        label,
        status,
      );
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
  onThreadStatus(status: string): void;
  onRootTurnOpened(turnId: string): void;
  onTerminalError(category: ProviderErrorCategory, detail: string): void;
}

export class CodexTranslator {
  awaitingReplayedUsage: boolean;
  private rateLimits = new Map<string, RateLimits>();
  private retryErrors = new Map<string, { info: unknown; text: string }>();
  private agents = new Map<string, TrackedAgent>();
  private parentByThread = new Map<string, string>();
  private parentByTurn = new Map<string, string>();

  constructor(
    private readonly events: EventBuilder,
    private readonly injected: Map<string, Presentation | undefined>,
    private readonly hooks: CodexTranslatorHooks,
    resumed: boolean,
  ) {
    this.awaitingReplayedUsage = resumed;
  }

  handle(method: string, params: unknown) {
    if (NOISE.has(method) || this.isConditionalNoise(method, params)) return;
    const handled = this.dispatch(method, params);
    if (!handled)
      this.events.unhandled({ rawType: method, raw: rawEvent(method, params) });
  }

  openTurn(threadId: string, turnId: string) {
    this.rateLimits.clear();
    this.awaitingReplayedUsage = false;
    const agent = [...this.agents.values()].find(
      (a) => a.agentThreadId === threadId,
    );
    if (agent && !agent.open) this.openAgent(agent);
    const parentRef = this.parentRef(threadId, turnId);
    if (parentRef !== undefined) this.parentByTurn.set(turnId, parentRef);
    this.events.openTurn({ turn: turnId, parentRef });
    if (parentRef === undefined) this.hooks.onRootTurnOpened(turnId);
  }

  closeTurn(threadId: string, turn: z.infer<typeof turnSchema>) {
    this.retryErrors.delete(`${threadId}\0${turn.id}`);
    const status = turn.status === "inProgress" ? "completed" : turn.status;
    const error = turn.error?.message || undefined;
    this.events.closeTurn({
      turn: turn.id,
      status,
      error,
      checkpointId: turn.id,
    });
    const agent = this.agents.get(this.parentByTurn.get(turn.id) ?? "");
    if (agent?.open) this.closeAgent(agent, status);
  }

  closeAgents(status: "failed" | "interrupted", threadId?: string) {
    let closed = false;
    for (const agent of this.agents.values()) {
      const related =
        threadId === undefined || agent.agentThreadId === threadId;
      if (!agent.open || !related) continue;
      this.closeAgent(agent, status);
      closed = true;
    }
    return closed;
  }

  private isConditionalNoise(method: string, params: unknown) {
    if (!isRecord(params)) return false;
    if (method === "hook/started" || method === "hook/completed") {
      const status = isRecord(params.run) ? params.run.status : undefined;
      return status === "running" || status === "completed";
    }
    if (method === "item/commandExecution/terminalInteraction") {
      return params.stdin === "";
    }
    return false;
  }

  private parentRef(threadId: string, turnId?: string) {
    const byTurn =
      turnId === undefined ? undefined : this.parentByTurn.get(turnId);
    return byTurn ?? this.parentByThread.get(threadId);
  }

  private agentShape(agent: TrackedAgent) {
    const { agentThreadId: childRef, agentPath: label } = agent;
    return { type: "delegation" as const, childRef, label, background: false };
  }

  private openAgent(agent: TrackedAgent) {
    agent.open = true;
    const { callId: providerItemId, parentRef, turn, agentPath } = agent;
    const options = { turn, presentation: agentPresentation(agentPath) };
    const key = { providerItemId, parentRef };
    this.events.openItem(key, this.agentShape(agent), options);
  }

  private closeAgent(
    agent: TrackedAgent,
    status: "completed" | "failed" | "interrupted",
  ) {
    agent.open = false;
    const { callId: providerItemId, parentRef, turn, agentPath } = agent;
    const options = {
      turn,
      status,
      presentation: agentPresentation(agentPath),
    };
    const key = { providerItemId, parentRef };
    this.events.closeItem(key, this.agentShape(agent), options);
  }

  private subAgentActivity(
    threadId: string,
    turn: string,
    callId: string,
    item: Extract<CodexItem, { type: "subAgentActivity" }>,
  ) {
    const { agentThreadId, agentPath, kind } = item;
    const tracked = [...this.agents.values()].find(
      (agent) => agent.agentThreadId === agentThreadId,
    );
    if (kind === "interrupted" && tracked?.open) {
      this.closeAgent(tracked, "interrupted");
    }
    if (kind !== "started" || this.agents.has(callId)) return;
    const parentRef = this.parentRef(threadId, turn);
    const state = { callId, agentThreadId, agentPath, turn, parentRef };
    const agent = { ...state, open: false };
    this.agents.set(callId, agent);
    this.parentByThread.set(agentThreadId, callId);
    this.openAgent(agent);
  }

  private item(method: string, params: unknown) {
    const envelope = itemEvent.safeParse(params);
    if (!envelope.success) return false;
    const { threadId, turnId: turn, item: raw } = envelope.data;
    const parsed = itemSchema.safeParse(raw);
    const closing = method === "item/completed";
    const parentRef = this.parentRef(threadId, turn);
    if (parsed.success && parsed.data.type === "subAgentActivity") {
      if (closing) this.subAgentActivity(threadId, turn, raw.id, parsed.data);
      return true;
    }
    const translated = parsed.success
      ? translateItem(parsed.data, this.injected)
      : "unhandled";
    if (translated === "ignored") return true;
    if (translated === "unhandled") {
      const event = rawEvent(method, params);
      this.events.unhandled({ rawType: method, raw: event, turn, parentRef });
      return true;
    }
    const key = { providerItemId: raw.id, parentRef };
    const { shape, presentation: label, status, denied } = translated;
    if (shape.type === "delegation" && shape.childRef !== threadId) {
      this.parentByThread.set(shape.childRef, raw.id);
    }
    const options = { turn, presentation: label };
    if (closing)
      this.events.closeItem(key, shape, { ...options, status, denied });
    else this.events.openItem(key, shape, options);
    return true;
  }

  private delta(method: string, params: unknown) {
    const parsed = deltaEvent.safeParse(params);
    if (!parsed.success) return false;
    const { threadId, turnId: turn, itemId, delta } = parsed.data;
    const key = {
      providerItemId: itemId,
      parentRef: this.parentRef(threadId, turn),
    };
    const { events } = this;
    switch (method) {
      case "item/agentMessage/delta":
        events.textDelta(key, "agentMessage", delta, { turn });
        break;
      case "item/reasoning/summaryTextDelta":
        events.textDelta(key, "reasoningSummary", delta, { turn });
        break;
      case "item/reasoning/textDelta":
        events.textDelta(key, "reasoningText", delta, { turn });
        break;
      case "item/plan/delta":
        events.textDelta(key, "plan", delta, { turn });
        break;
      case "item/commandExecution/outputDelta":
        events.outputDelta(key, "command", delta, { turn });
        break;
      default:
        events.outputDelta(key, "fileChange", delta, { turn });
    }
    return true;
  }

  private dispatch(method: string, params: unknown): boolean {
    const { events } = this;
    const read = <S extends z.ZodType>(
      schema: S,
      run: (data: z.infer<S>) => void,
    ) => {
      const parsed = schema.safeParse(params);
      if (parsed.success) run(parsed.data);
      return parsed.success;
    };
    switch (method) {
      case "item/started":
      case "item/completed":
        return this.item(method, params);
      case "item/agentMessage/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
      case "item/plan/delta":
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
        return this.delta(method, params);
      case "turn/started":
        return read(turnEvent, (p) => this.openTurn(p.threadId, p.turn.id));
      case "turn/completed":
        return read(turnEvent, (p) => this.closeTurn(p.threadId, p.turn));
      case "thread/status/changed": {
        const schema = z.object({
          threadId: text,
          status: z.object({ type: text }),
        });
        read(schema, (p) => {
          const root = p.threadId === this.hooks.rootThreadId();
          if (root) this.hooks.onThreadStatus(p.status.type);
        });
        return true;
      }
      case "thread/started": {
        const thread = z.object({ id: text.min(1), preview: text.optional() });
        return read(z.object({ thread }), ({ thread: { id, preview } }) => {
          const root = this.hooks.rootThreadId();
          if (root !== null && root !== id) return;
          events.started();
          events.identity(id);
          if (preview) events.name(fromProviderExternalThreadName(preview));
        });
      }
      case "thread/name/updated": {
        const schema = z.object({
          threadId: text,
          threadName: text.optional(),
        });
        return read(schema, ({ threadId, threadName }) => {
          const root = threadId === this.hooks.rootThreadId();
          if (root && threadName)
            events.name(fromProviderExternalThreadName(threadName));
        });
      }
      case "thread/compacted":
        return read(z.object(scoped), (p) =>
          events.compacted({ turn: p.turnId }),
        );
      case "thread/goal/updated":
        return read(z.object({ goal: goalSchema }), ({ goal }) =>
          events.extensionState(GOAL_KIND, goal),
        );
      case "thread/goal/cleared":
        events.extensionState(GOAL_KIND, null);
        return true;
      case "thread/closed": {
        const closed = (p: { threadId: string }) =>
          this.closeAgents("failed", p.threadId);
        const parsed = z.object({ threadId: text }).safeParse(params);
        return parsed.success && closed(parsed.data);
      }
      case "item/mcpToolCall/progress": {
        const schema = z.object({
          ...scoped,
          itemId: text,
          message: text.optional(),
        });
        return read(schema, ({ threadId, turnId: turn, itemId, message }) => {
          const parentRef = this.parentRef(threadId, turn);
          const key = { providerItemId: itemId, parentRef };
          events.progress(key, { turn, message: message || undefined });
        });
      }
      case "thread/tokenUsage/updated": {
        const tokenUsage = z.object({
          total: usageSchema,
          last: usageSchema,
          modelContextWindow: nullableNumber,
        });
        return read(
          z.object({ ...scoped, tokenUsage }),
          ({ turnId, tokenUsage: u }) => {
            const cached = (usage: z.infer<typeof usageSchema>) => ({
              ...usage,
              cacheReadInputTokens: usage.cachedInputTokens,
            });
            const replayed = this.awaitingReplayedUsage;
            const turn = replayed ? undefined : turnId;
            const size = u.modelContextWindow;
            const total = cached(u.total);
            const last = cached(u.last);
            if (!replayed)
              events.usage({ turn, total, last, modelContextWindow: size });
            const used = u.last.totalTokens;
            events.contextWindow({ turn, used, size, estimated: false });
          },
        );
      }
      case "turn/plan/updated": {
        const step = z.object({
          step: text,
          status: z.enum(["pending", "inProgress", "completed", "failed"]),
        });
        const plan = z.array(step);
        const schema = z.object({
          ...scoped,
          plan,
          explanation: text.nullish(),
        });
        return read(schema, ({ turnId: turn, plan: raw, explanation }) => {
          const steps = raw.map(({ step: label, status }) => ({
            step: label,
            status: status === "inProgress" ? ("active" as const) : status,
          }));
          const active = steps.find((s) => s.status === "active")?.step;
          const label = planStepsPresentation(
            active ?? explanation ?? undefined,
          );
          const shape = { type: "planSteps" as const, steps };
          const item = explanation ? { ...shape, explanation } : shape;
          const options = {
            turn,
            status: "completed" as const,
            presentation: label,
          };
          events.closeItem({ channel: "planSteps" }, item, options);
        });
      }
      case "account/rateLimits/updated":
        return read(
          z.object({ rateLimits: rateLimitSchema }),
          ({ rateLimits }) => {
            const limitId = rateLimits.limitId ?? "codex";
            const merged = mergeRateLimits(
              this.rateLimits.get(limitId),
              rateLimits,
            );
            this.rateLimits.set(limitId, merged);
            const latest = normalizeRateLimits(merged);
            const base = this.rateLimits.get("codex");
            const main =
              base && limitId !== "codex" ? normalizeRateLimits(base) : latest;
            const [chosen, other] =
              RANK[main.status] > RANK[latest.status]
                ? [main, latest]
                : [latest, main];
            const blocked =
              other === chosen || other.status !== "blocked"
                ? []
                : other.windows;
            const extra = blocked.filter(
              (window) => window.status === "blocked",
            );
            events.rateLimits({
              ...chosen,
              windows: [...chosen.windows, ...extra],
            });
          },
        );
      case "error": {
        const schema = z.object({
          threadId: text,
          turnId: text.optional(),
          error: errorSchema,
          willRetry: z.boolean().optional(),
        });
        return read(schema, ({ threadId, turnId: turn, error, willRetry }) => {
          const failure = error.additionalDetails ?? error.message;
          const key = `${threadId}\0${turn ?? ""}`;
          let info = error.codexErrorInfo;
          if (willRetry === true && info && info !== "other") {
            this.retryErrors.set(key, { info, text: failure });
          } else if (willRetry === false) {
            const retried = this.retryErrors.get(key);
            this.retryErrors.delete(key);
            if (info === "other" && retried?.text === failure)
              info = retried.info;
          }
          const detail = error.additionalDetails
            ? `${error.message}\n${error.additionalDetails}`
            : error.message;
          const threadScoped = turn === undefined;
          const details = { detail, willRetry, info: errorInfo(info) };
          events.error({ ...details, turn, threadScoped });
          const category = details.info?.category ?? "unknown";
          if (willRetry !== true) this.hooks.onTerminalError(category, detail);
        });
      }
      case "deprecationNotice":
      case "configWarning": {
        const category = method === "configWarning" ? "config" : "deprecation";
        return read(warningEvent, ({ summary, details }) =>
          events.warning({ category, summary, details: details || undefined }),
        );
      }
      case "warning":
        return read(z.object({ message: text }), ({ message }) =>
          events.warning({ summary: message }),
        );
      default:
        return false;
    }
  }
}
