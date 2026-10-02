import { randomUUID } from "node:crypto";
import {
  threadScope,
  turnScope,
  type ExtensionKind,
  type JsonValue,
  type ProviderRateLimitState,
  type ProviderRawEvent,
  type ThreadEventItem as Item,
  type ThreadEventItemPresentation as Presentation,
  type ThreadEventItemStatus as ItemStatus,
  type ThreadEventTurnStatus as TurnStatus,
} from "@bb/domain";
import type { DistributiveOmit as Strip, RunnerThreadEvent } from "../types.js";

type Managed = "id" | "status" | "approvalStatus" | "parentToolCallId";
type Draft = Strip<
  Extract<RunnerThreadEvent, { providerThreadId: unknown }>,
  "providerThreadId" | "scope"
>;
type Fields<T extends Draft["type"]> = Omit<
  Extract<Draft, { type: T }>,
  "type"
>;
type TokenUsage = Fields<"thread/tokenUsage/updated">["tokenUsage"];
type ContextWindow =
  Fields<"thread/contextWindowUsage/updated">["contextWindowUsage"];
type TextDeltaEvent = Extract<RunnerThreadEvent, { delta: string }>;
type TextItemType = "agentMessage" | "plan" | "reasoning";
type DeltaChannel = TextChannel | OutputChannel;

export type ItemShape = Strip<
  Exclude<Item, { type: "userMessage" | "extension" }>,
  Managed | "presentation"
>;
export type BackgroundTaskShape = Extract<
  ItemShape,
  { type: "backgroundTask" }
>;
export type TextChannel = keyof typeof CHANNEL_ITEM;
export type OutputChannel = "command" | "fileChange";
export interface ItemKey {
  providerItemId?: string;
  channel?: string;
  parentRef?: string;
}
export interface TurnTarget {
  turn?: string;
}
export interface ItemOptions extends TurnTarget {
  presentation?: Presentation;
}
export interface CloseOptions extends TurnTarget {
  status: ItemStatus;
  presentation?: Presentation;
  denied?: boolean;
}
export interface ProgressOptions extends TurnTarget {
  message?: string;
  flush?: boolean;
  snapshot?: { shape: BackgroundTaskShape; status: ItemStatus };
}
export interface ErrorOptions extends TurnTarget {
  settlesTurn?: boolean;
  threadScoped?: boolean;
}
export interface RawOptions extends TurnTarget {
  inTurn?: boolean;
  parentRef?: string;
}
export interface EventBuilderOptions {
  providerId: string;
  emit: (event: RunnerThreadEvent) => void;
  textFlushMs?: number;
  progressThrottleMs?: number;
  now?: () => number;
}

interface OpenItem {
  id: string;
  key: ItemKey;
  shape: ItemShape;
  presentation: Presentation | undefined;
  parent: string | undefined;
  turnId: string;
  text: string;
  summary: string;
}

const SEP = "\u001f";
const MAX_TRACKED = 1024;
const MAX_GUARDED = 512;
const CHANNEL_ITEM = {
  agentMessage: "agentMessage",
  plan: "plan",
  reasoningText: "reasoning",
  reasoningSummary: "reasoning",
} as const;
const OUTPUT_EVENT = {
  command: "item/commandExecution/outputDelta",
  fileChange: "item/fileChange/outputDelta",
} as const;
const CHANNEL_EVENT = {
  agentMessage: "item/agentMessage/delta",
  plan: "item/plan/delta",
  reasoningText: "item/reasoning/textDelta",
  reasoningSummary: "item/reasoning/summaryTextDelta",
} as const;

function keyOf(key: ItemKey) {
  return [key.providerItemId, key.channel, key.parentRef].join(SEP);
}

function trim<K>(collection: Map<K, unknown> | Set<K>, max: number) {
  for (const key of collection.keys()) {
    if (collection.size <= max) return;
    collection.delete(key);
  }
}

function withoutUndefined<T extends object>(value: T): T {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return Object.fromEntries(entries) as T;
}

function isThreadAttached(shape: ItemShape) {
  const background = shape.type === "delegation" && shape.background;
  return shape.type === "backgroundTask" || background;
}

function isTextItemType(type: string): type is TextItemType {
  return type === "agentMessage" || type === "plan" || type === "reasoning";
}

function textShape(type: TextItemType, text: string, summary: string) {
  return type === "reasoning"
    ? { type, summary: summary ? [summary] : [], content: text ? [text] : [] }
    : { type, text };
}

function buildItem(
  shape: ItemShape,
  id: string,
  status: ItemStatus,
  extra: { presentation?: Presentation; parent?: string; denied?: boolean },
): Item {
  const { presentation, parent: parentToolCallId } = extra;
  const common = withoutUndefined({ id, presentation, parentToolCallId });
  switch (shape.type) {
    case "commandExecution":
    case "fileChange": {
      const approvalStatus = extra.denied ? ("denied" as const) : null;
      return withoutUndefined({ ...shape, ...common, status, approvalStatus });
    }
    case "toolCall":
    case "fileRead":
    case "search":
    case "delegation":
    case "planSteps":
    case "imageGeneration":
    case "backgroundTask":
      return withoutUndefined({ ...shape, ...common, status });
    default:
      return withoutUndefined({ ...shape, ...common });
  }
}

export class EventBuilder {
  private readonly prefix = `da${randomUUID().slice(0, 8)}`;
  private readonly textFlushMs: number;
  private readonly progressMs: number;
  private readonly now: () => number;
  private counters = { turn: 0, item: 0 };
  private identityId: string | null = null;
  private held: RunnerThreadEvent[] = [];
  private rootTurn: string | null = null;
  private lastRootTurn: string | undefined;
  private accepted: string[] = [];
  private open = new Map<string, OpenItem>();
  private bbItems = new Map<string, string>();
  private bbTurns = new Map<string, string>();
  private providerTurns = new Map<string, string>();
  private progressAt = new Map<string, number>();
  private pendingProgress = new Map<string, RunnerThreadEvent>();
  private textAt = new Map<string, number>();
  private pendingText = new Map<string, TextDeltaEvent>();
  private liveTurns = new Set<string>();
  private doneTurns = new Set<string>();
  private liveItems = new Set<string>();
  private doneItems = new Set<string>();

  constructor(private readonly options: EventBuilderOptions) {
    this.textFlushMs = options.textFlushMs ?? 100;
    this.progressMs = options.progressThrottleMs ?? 500;
    this.now = options.now ?? Date.now;
  }

  get activeTurnId() {
    return this.rootTurn;
  }

  hasOpenBackgroundWork() {
    const background = new Set(["backgroundTask", "delegation"]);
    return [...this.open.values()].some((i) => background.has(i.shape.type));
  }

  bbItemId(providerItemId: string) {
    return this.bbItems.get(providerItemId);
  }

  bbTurnId(providerTurnId: string) {
    return this.bbTurns.get(providerTurnId);
  }

  providerTurnId(bbTurnId: string) {
    return this.providerTurns.get(bbTurnId);
  }

  identity(providerThreadId: string) {
    this.flush();
    const first = this.identityId === null;
    this.identityId = providerThreadId;
    const scope = threadScope();
    this.options.emit({ type: "thread/identity", providerThreadId, scope });
    if (!first) return;
    for (const event of this.held.splice(0))
      this.options.emit(this.stamp(event));
  }

  started() {
    this.push({ type: "thread/started", scope: threadScope() });
  }

  name(threadName: string) {
    this.send(undefined, { type: "thread/name/updated", threadName });
  }

  rateLimits(rateLimits: ProviderRateLimitState) {
    this.send(undefined, { type: "provider/rateLimits/updated", rateLimits });
  }

  extensionState(kind: ExtensionKind, payload: JsonValue) {
    const type = "thread/extensionState/updated";
    this.send(undefined, { type, kind, payload });
  }

  acceptInput(clientRequestId: string, t?: TurnTarget) {
    const turnId = this.target(t);
    if (turnId === undefined) this.accepted.push(clientRequestId);
    else this.send(turnId, { type: "turn/input/accepted", clientRequestId });
  }

  retractInput(clientRequestId: string) {
    this.accepted = this.accepted.filter((id) => id !== clientRequestId);
  }

  openTurn(args: TurnTarget & { parentRef?: string } = {}) {
    const parentToolCallId = this.parentOf(args.parentRef);
    const turnId = this.turnId(args.turn ?? randomUUID());
    this.send(turnId, { type: "turn/started", parentToolCallId });
    if (parentToolCallId !== undefined) return turnId;
    for (const clientRequestId of this.accepted.splice(0)) {
      this.send(turnId, { type: "turn/input/accepted", clientRequestId });
    }
    return turnId;
  }

  closeTurn(
    args: TurnTarget & {
      status: TurnStatus;
      error?: string;
      checkpointId?: string;
    },
  ) {
    const turnId = this.target(args);
    if (turnId === undefined) return;
    this.sendTurnCompleted(turnId, args.status, args.error, args.checkpointId);
  }

  openItem(key: ItemKey, shape: ItemShape, options: ItemOptions = {}) {
    const turnId = this.target(options);
    if (turnId === undefined) return undefined;
    if (shape.type !== "contextCompaction") this.detachAssistant(key);
    const id = this.resolveItemId(key, undefined);
    const parent = this.parentOf(key.parentRef);
    const { presentation } = options;
    const state = { id, key, shape, presentation, parent, turnId };
    const k = keyOf(key);
    this.open.set(k, { ...state, text: "", summary: "" });
    trim(this.open, MAX_TRACKED);
    this.progressAt.set(k, this.now());
    trim(this.progressAt, MAX_TRACKED);
    const item = buildItem(shape, id, "pending", { presentation, parent });
    this.send(turnId, { type: "item/started", item });
    return id;
  }

  closeItem(key: ItemKey, shape: ItemShape, options: CloseOptions) {
    const threadScoped = isThreadAttached(shape);
    const turnId = threadScoped ? undefined : this.target(options);
    if (!threadScoped && turnId === undefined) return;
    const k = keyOf(key);
    const open = this.open.get(k);
    const stale =
      !threadScoped && open && open.shape.type !== shape.type ? open : null;
    const id = this.resolveItemId(key, open);
    const item = buildItem(stale?.shape ?? shape, id, options.status, {
      presentation: stale
        ? stale.presentation
        : (options.presentation ?? open?.presentation),
      parent: this.parentOf(key.parentRef) ?? open?.parent,
      denied: options.denied,
    });
    this.forget(k);
    if (item.type === "backgroundTask") {
      this.send(undefined, { type: "item/backgroundTask/completed", item });
    } else if (item.type === "delegation" && item.background) {
      this.send(undefined, { type: "item/delegation/completed", item });
    } else if (turnId !== undefined) {
      this.send(turnId, { type: "item/completed", item });
    }
  }

  progress(key: ItemKey, options: ProgressOptions = {}) {
    const k = keyOf(key);
    this.pendingProgress.delete(k);
    const itemId = this.open.get(k)?.id ?? this.knownItemId(key);
    const { message, snapshot } = options;
    const turnId = snapshot ? undefined : this.target(options);
    if (itemId === undefined || (!snapshot && turnId === undefined)) return;
    const parentToolCallId = this.parentOf(key.parentRef);
    const item = snapshot && {
      ...snapshot.shape,
      id: itemId,
      status: snapshot.status,
      parentToolCallId,
    };
    const event = this.draft(
      turnId,
      item
        ? { type: "item/backgroundTask/progress", item: withoutUndefined(item) }
        : { type: "item/toolCall/progress", itemId, message, parentToolCallId },
    );
    const elapsed = this.now() - (this.progressAt.get(k) ?? -Infinity);
    if (elapsed < this.progressMs && options.flush !== true) {
      this.pendingProgress.set(k, event);
      return;
    }
    this.progressAt.set(k, this.now());
    this.push(event);
  }

  modelFallback(fallback: Fields<"provider/modelFallback">) {
    const turnId = this.target(undefined, true);
    this.send(turnId, { type: "provider/modelFallback", ...fallback });
  }

  delta(key: ItemKey, channel: DeltaChannel, delta: string, t?: TurnTarget) {
    const turnId = this.target(t);
    if (turnId === undefined) return;
    const k = keyOf(key);
    const parentToolCallId = this.parentOf(key.parentRef);
    let open = this.open.get(k);
    let itemId = open?.id ?? this.knownItemId(key);
    if (channel === "command" || channel === "fileChange") {
      if (itemId === undefined) return;
      const type = OUTPUT_EVENT[channel];
      this.send(turnId, { type, itemId, delta, parentToolCallId });
      return;
    }
    if (itemId === undefined) {
      itemId = this.resolveItemId(key, undefined);
      const shape = textShape(CHANNEL_ITEM[channel], "", "");
      const state = { id: itemId, key, shape, presentation: undefined };
      const parent = parentToolCallId;
      open = { ...state, parent, turnId, text: "", summary: "" };
      this.open.set(k, open);
      const item = buildItem(shape, itemId, "pending", { parent });
      this.send(turnId, { type: "item/started", item });
    }
    if (open !== undefined) {
      if (channel === "reasoningSummary") open.summary += delta;
      else open.text += delta;
    }
    const type = CHANNEL_EVENT[channel];
    this.send(turnId, { type, itemId, delta, parentToolCallId });
  }

  textClose(key: ItemKey, channel: TextChannel, text?: string, t?: TurnTarget) {
    const turnId = this.target(t);
    if (turnId === undefined) return;
    const k = keyOf(key);
    const open = this.open.get(k);
    this.open.delete(k);
    const summaryChannel = channel === "reasoningSummary";
    const finalText = text ?? (summaryChannel ? open?.summary : open?.text);
    if (!finalText || (text === undefined && finalText.trim() === "")) return;
    const openType = open?.shape.type ?? "";
    const type = isTextItemType(openType) ? openType : CHANNEL_ITEM[channel];
    const shape = summaryChannel
      ? textShape(type, open?.text ?? "", finalText)
      : textShape(type, finalText, open?.summary ?? "");
    const item = buildItem(shape, this.resolveItemId(key, open), "completed", {
      presentation: open?.presentation,
      parent: this.parentOf(key.parentRef) ?? open?.parent,
    });
    this.send(turnId, { type: "item/completed", item });
  }

  usage(tokenUsage: TokenUsage, t?: TurnTarget) {
    const turnId = this.target(t, true);
    const type = "thread/tokenUsage/updated";
    if (turnId !== undefined) this.send(turnId, { type, tokenUsage });
  }

  contextWindow(usage: ContextWindow, t?: TurnTarget, openOnly = false) {
    const type = "thread/contextWindowUsage/updated";
    const turnId = this.target(t, !openOnly);
    this.send(turnId, { type, contextWindowUsage: usage });
  }

  compacted(t?: TurnTarget) {
    const turnId = this.target(t, true);
    if (turnId !== undefined) this.send(turnId, { type: "thread/compacted" });
  }

  cleared() {
    const turnId = this.target(undefined, true);
    if (turnId) this.send(turnId, { type: "thread/context/cleared" });
  }

  error(report: Partial<Fields<"provider/error">>, options: ErrorOptions = {}) {
    const inThread = options.threadScoped && options.turn === undefined;
    const claim = !inThread && this.accepted.length > 0;
    const turnId = inThread
      ? undefined
      : (this.target(options) ?? (claim ? this.openTurn() : undefined));
    const message = report.message ?? "Provider error";
    this.send(turnId, { type: "provider/error", ...report, message });
    if (options.settlesTurn && turnId) this.sendTurnCompleted(turnId, "failed");
  }

  warning(warning: Partial<Fields<"provider/warning">>) {
    const category = warning.category ?? "general";
    this.send(undefined, { type: "provider/warning", ...warning, category });
  }

  unhandled(rawType: string, rawEvent: ProviderRawEvent, to: RawOptions = {}) {
    const scoped = to.turn !== undefined || to.inTurn;
    const turnId = scoped ? this.target(to) : undefined;
    const parentToolCallId = this.parentOf(to.parentRef);
    const { providerId } = this.options;
    const origin = { providerId, rawType, rawEvent, parentToolCallId };
    this.send(turnId, { type: "provider/unhandled", ...origin });
  }

  settle(status: "interrupted" | "failed", error?: string) {
    this.flush();
    if (this.liveTurns.size === 0 && this.accepted.length > 0) this.openTurn();
    for (const [k, open] of this.open) {
      const { turnId, shape, presentation, parent } = open;
      if (isThreadAttached(shape) || !this.liveTurns.has(turnId)) continue;
      this.open.delete(k);
      const streamed = open.text.length > 0 || open.summary.length > 0;
      const settled =
        streamed && isTextItemType(shape.type)
          ? textShape(shape.type, open.text, open.summary)
          : shape;
      const extra = { presentation, parent };
      const item = buildItem(settled, open.id, status, extra);
      this.send(turnId, { type: "item/completed", item });
    }
    for (const turnId of [...this.liveTurns].reverse()) {
      this.sendTurnCompleted(turnId, status, error);
    }
  }

  flush() {
    if (this.pendingText.size === 0) return;
    const pending = [...this.pendingText];
    this.pendingText.clear();
    for (const [stream, event] of pending) {
      this.out(event);
      this.textAt.set(stream, this.now());
    }
  }

  private mint(kind: "turn" | "item") {
    this.counters[kind] += 1;
    return `${this.prefix}-${kind[0]}${this.counters[kind]}`;
  }

  private target(target?: TurnTarget, orLast = false) {
    if (target?.turn !== undefined) return this.turnId(target.turn);
    return this.rootTurn ?? (orLast ? this.lastRootTurn : undefined);
  }

  private turnId(providerTurnId: string) {
    const known = this.bbTurns.get(providerTurnId);
    if (known !== undefined) return known;
    const turnId = this.mint("turn");
    this.bbTurns.set(providerTurnId, turnId);
    this.providerTurns.set(turnId, providerTurnId);
    trim(this.bbTurns, MAX_TRACKED);
    trim(this.providerTurns, MAX_TRACKED);
    return turnId;
  }

  private knownItemId(key: ItemKey) {
    const { providerItemId } = key;
    return providerItemId ? this.bbItems.get(providerItemId) : undefined;
  }

  private resolveItemId(key: ItemKey, open: OpenItem | undefined) {
    const id = open?.id ?? this.knownItemId(key) ?? this.mint("item");
    if (key.providerItemId !== undefined) this.register(key.providerItemId, id);
    return id;
  }

  private register(providerItemId: string, id: string) {
    this.bbItems.set(providerItemId, id);
    trim(this.bbItems, MAX_TRACKED);
  }

  private parentOf(parentRef: string | undefined) {
    if (parentRef === undefined) return undefined;
    const existing = this.bbItems.get(parentRef);
    if (existing !== undefined) return existing;
    const id = this.mint("item");
    this.register(parentRef, id);
    return id;
  }

  private detachAssistant(key: ItemKey) {
    for (const [k, item] of this.open) {
      const anonymous = item.key.providerItemId === undefined;
      const sameParent = item.key.parentRef === key.parentRef;
      const assistant = item.shape.type === "agentMessage";
      if (anonymous && sameParent && assistant) this.open.delete(k);
    }
  }

  private forget(k: string) {
    this.open.delete(k);
    this.pendingProgress.delete(k);
    this.progressAt.delete(k);
  }

  private sendTurnCompleted(
    turnId: string,
    status: TurnStatus,
    message?: string,
    providerCheckpointId?: string,
  ) {
    const error = message ? { message } : undefined;
    const type = "turn/completed";
    this.send(turnId, { type, status, error, providerCheckpointId });
    for (const [k, item] of this.open) {
      const ended = item.turnId === turnId && !isThreadAttached(item.shape);
      if (ended) this.forget(k);
    }
  }

  private draft(turnId: string | undefined, draft: Draft): RunnerThreadEvent {
    const scope = turnId === undefined ? threadScope() : turnScope(turnId);
    return { ...withoutUndefined(draft), providerThreadId: "", scope };
  }

  private send(turnId: string | undefined, draft: Draft) {
    this.push(this.draft(turnId, draft));
  }

  private push(event: RunnerThreadEvent) {
    this.flushDue();
    if (this.textFlushMs > 0 && "delta" in event) return this.bufferText(event);
    this.flush();
    this.out(event);
  }

  private flushDue() {
    const now = this.now();
    for (const stream of this.pendingText.keys()) {
      const lastEmit = this.textAt.get(stream);
      if (lastEmit !== undefined && now - lastEmit < this.textFlushMs) continue;
      this.flush();
      break;
    }
    const due = [...this.pendingProgress].filter(
      ([k]) => now - (this.progressAt.get(k) ?? -Infinity) >= this.progressMs,
    );
    for (const [k] of due) {
      this.pendingProgress.delete(k);
      this.progressAt.set(k, now);
    }
    for (const [, event] of due) this.push(event);
  }

  private bufferText(event: TextDeltaEvent) {
    const stream = `${event.type}${SEP}${event.itemId}`;
    const lastEmit = this.textAt.get(stream);
    if (lastEmit === undefined) {
      this.flush();
      this.out(event);
      this.textAt.set(stream, this.now());
      trim(this.textAt, MAX_TRACKED);
      return;
    }
    const pending = this.pendingText.get(stream);
    const delta = (pending?.delta ?? "") + event.delta;
    this.pendingText.set(stream, { ...(pending ?? event), delta });
    if (this.now() - lastEmit >= this.textFlushMs) this.flush();
  }

  private out(event: RunnerThreadEvent) {
    if (!this.allowed(event)) return;
    if (this.identityId === null) this.held.push(event);
    else this.options.emit(this.stamp(event));
  }

  private stamp(event: RunnerThreadEvent): RunnerThreadEvent {
    const providerThreadId = this.identityId;
    const unstamped = "providerThreadId" in event && !event.providerThreadId;
    return unstamped && providerThreadId
      ? { ...event, providerThreadId }
      : event;
  }

  private allowed(event: RunnerThreadEvent) {
    const turnId = event.scope.kind === "turn" ? event.scope.turnId : "";
    switch (event.type) {
      case "turn/started":
        if (this.liveTurns.has(turnId) || this.doneTurns.has(turnId)) {
          return false;
        }
        this.liveTurns.add(turnId);
        if (event.parentToolCallId === undefined) this.rootTurn = turnId;
        return true;
      case "turn/completed":
        if (!this.liveTurns.delete(turnId)) return false;
        this.doneTurns.add(turnId);
        trim(this.doneTurns, MAX_GUARDED);
        if (this.rootTurn !== turnId) return true;
        this.rootTurn = null;
        this.lastRootTurn = turnId;
        return true;
      case "item/started":
        this.liveItems.add(event.item.id);
        this.doneItems.delete(event.item.id);
        trim(this.liveItems, MAX_GUARDED);
        return true;
      case "item/completed":
      case "item/backgroundTask/completed":
      case "item/delegation/completed":
        if (this.doneItems.has(event.item.id)) return false;
        this.liveItems.delete(event.item.id);
        this.doneItems.add(event.item.id);
        trim(this.doneItems, MAX_GUARDED);
        return true;
      case "item/backgroundTask/progress":
        return this.liveItems.has(event.item.id);
      default:
        return !("itemId" in event) || this.liveItems.has(event.itemId);
    }
  }
}
