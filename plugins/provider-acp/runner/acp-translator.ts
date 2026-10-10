import { threadUsageCostSchema } from "@bb/domain";
import type {
  ThreadEventItemStatus,
  ThreadEventPlanStep,
  ThreadEventTurnStatus,
  ThreadUsageCost,
  ThreadEventItemPresentation,
} from "@bb/domain";
import {
  buildEditDiff,
  type EventBuilder,
  type ItemKey,
  type ItemShape,
  labels,
  presentationTitle,
} from "@bb/runner";
import {
  GENERIC_ACP_DIALECT,
  type AcpDelegationReport,
  type AcpDialect,
} from "./dialect.js";
import {
  delegationPresentation,
  fileChangePresentation,
} from "./presentation.js";
import {
  classifyAcpToolCall,
  extractAcpCommandResult,
  extractAcpStreamedCommandOutput,
  extractAcpToolCallOutputText,
  isInjectedToolCandidate,
  type AcpClassifiedToolCall,
  type AcpInjectedTool,
} from "./tool-classification.js";
import { resolveAcpToolCallPath } from "./tool-call-operation.js";
import { isJsonObject } from "./session/decode.js";
import {
  acpAgentMessageChunkUpdateSchema,
  acpAgentThoughtChunkUpdateSchema,
  acpPlanUpdateSchema,
  acpToolCallUpdateEventSchema,
  acpUsageUpdateSchema,
  extractAcpContentText,
  type AcpSessionUpdate,
  type AcpStopReason,
  type AcpToolCallContent,
  type AcpToolCallUpdateEvent,
} from "./wire.js";

type TextChannel = "agentMessage" | "reasoningSummary" | "reasoningText";

interface AcpItemResult {
  resultText?: string;
  exitCode?: number;
  aggregatedOutput?: string;
}

interface AcpItemClose extends AcpItemResult {
  status: ThreadEventItemStatus;
  presentation?: ThreadEventItemPresentation | undefined;
}

export type AcpCompactionOutcome =
  | { status: "completed" }
  | { status: "interrupted" }
  | { status: "skipped"; detail: string }
  | { status: "failed"; error: string };

export interface AcpFileWrite {
  path: string;
  kind: "add" | "update";
  oldText?: string | undefined;
  content: string;
}

function defined<T extends object>(value: T): T {
  const kept = Object.entries(value).filter(([, v]) => v !== undefined);
  return Object.fromEntries(kept) as T;
}

function withResult(shape: ItemShape, result: AcpItemResult): ItemShape {
  switch (shape.type) {
    case "commandExecution":
      return defined({
        ...shape,
        aggregatedOutput: result.aggregatedOutput ?? shape.aggregatedOutput,
        exitCode: result.exitCode ?? shape.exitCode,
      });
    case "toolCall":
      return defined({ ...shape, result: shape.result ?? result.resultText });
    case "webSearch":
    case "webFetch":
      return { ...shape, resultText: result.resultText ?? shape.resultText };
    default:
      return shape;
  }
}

function createAcpEventWriter(events: EventBuilder) {
  let unclaimedInputs = 0;
  const openShapes = new Map<string, ItemShape>();
  const commandOutput = new Map<string, string>();
  const shapeKey = (key: ItemKey) =>
    [key.providerItemId, key.channel, key.parentRef].join("\u001f");

  return {
    events,
    acceptInput(clientRequestId: string): void {
      if (events.activeTurnId === null) unclaimedInputs += 1;
      events.acceptInput(clientRequestId);
    },
    openTurn(): void {
      unclaimedInputs = 0;
      events.openTurn({});
    },
    closeTurn(close: {
      status: ThreadEventTurnStatus;
      error?: string;
      claimIfIdle?: boolean;
    }): void {
      const idle = events.activeTurnId === null;
      if (idle && close.claimIfIdle === true && unclaimedInputs > 0) {
        unclaimedInputs = 0;
        events.openTurn();
      }
      openShapes.clear();
      commandOutput.clear();
      events.closeTurn({ status: close.status, error: close.error });
    },
    openItem(
      key: ItemKey,
      shape: ItemShape,
      presentation?: ThreadEventItemPresentation,
    ): void {
      openShapes.set(shapeKey(key), shape);
      events.openItem(key, shape, { presentation });
    },
    closeItem(key: ItemKey, item: ItemShape, close: AcpItemClose): void {
      const shape = withResult(item, close);
      const stale = openShapes.get(shapeKey(key));
      openShapes.delete(shapeKey(key));
      commandOutput.delete(shapeKey(key));
      const { status, presentation } = close;
      const closing = { status, presentation, denied: false };
      if (stale === undefined || stale.type === shape.type) {
        events.closeItem(key, shape, closing);
        return;
      }
      const channel = `${key.channel ?? "item"}:${shape.type}`;
      const retyped = { ...key, providerItemId: undefined, channel };
      events.closeItem(key, stale, { status });
      events.openItem(retyped, shape, { presentation });
      events.closeItem(retyped, shape, closing);
    },
    progress(key: ItemKey, message: string): void {
      events.progress(key, { message });
    },
    textDelta(key: ItemKey, channel: TextChannel, text: string): void {
      events.delta(key, channel, text, {});
    },
    textClose(key: ItemKey, channel: TextChannel): void {
      events.textClose(key, channel, undefined, {});
    },
    commandOutput(key: ItemKey, text: string): void {
      const sent = commandOutput.get(shapeKey(key));
      commandOutput.set(shapeKey(key), text);
      if (sent === undefined || !text.startsWith(sent)) {
        events.commandOutput(key, text, {});
      } else if (text.length > sent.length) {
        events.delta(key, "command", text.slice(sent.length), {});
      }
    },
  };
}

type AcpEventWriter = ReturnType<typeof createAcpEventWriter>;

const writersByEvents = new WeakMap<EventBuilder, AcpEventWriter>();

function acpEventWriterFor(events: EventBuilder): AcpEventWriter {
  const existing = writersByEvents.get(events);
  if (existing !== undefined) return existing;
  const created = createAcpEventWriter(events);
  writersByEvents.set(events, created);
  return created;
}

interface AcpTranslationScope {
  threadId?: string;
}

export interface AcpTranslatorOptions {
  threadId: string;
  events: () => EventBuilder | undefined;
  cwd?: string | undefined;
  dialect?: AcpDialect | undefined;
}

export interface AcpPermissionToolCallInput {
  toolCallId: string;
  title?: string | undefined;
  kind?: AcpToolCallUpdateEvent["kind"];
  rawKind?: string | undefined;
  content?: AcpToolCallUpdateEvent["content"];
  locations?: AcpToolCallUpdateEvent["locations"];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface AcpBoundPermissionToolCall {
  toolCallId: string;
  event: AcpToolCallUpdateEvent | undefined;
}

const ASSISTANT_STREAM_KEY = "assistant";
const THOUGHT_STREAM_KEY = "thought";
const ACP_PLAN_STEP_STATUS_BY_ENTRY_STATUS = {
  pending: "pending",
  in_progress: "active",
  completed: "completed",
} as const;

const PLAN_STEPS_CHANNEL = "planSteps";

function isTerminalAcpStatus(
  status: AcpToolCallUpdateEvent["status"],
): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function mapAcpToolCallStatus(
  status: AcpToolCallUpdateEvent["status"],
): ThreadEventItemStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "interrupted";
    default:
      return "pending";
  }
}

function mergeAcpToolCallEvents(
  started: AcpToolCallUpdateEvent | undefined,
  update: AcpToolCallUpdateEvent,
): AcpToolCallUpdateEvent {
  if (!started) {
    return update;
  }
  const { rawKind: startedRawKind, ...startedRest } = started;
  const kindFields =
    update.kind !== undefined
      ? {
          kind: update.kind,
          ...(update.rawKind !== undefined ? { rawKind: update.rawKind } : {}),
        }
      : startedRawKind !== undefined
        ? { rawKind: startedRawKind }
        : {};
  return {
    ...startedRest,
    ...kindFields,
    ...(update.title !== undefined ? { title: update.title } : {}),
    ...(update.name !== undefined ? { name: update.name } : {}),
    ...(update.status !== undefined ? { status: update.status } : {}),
    ...(update.content !== undefined ? { content: update.content } : {}),
    ...(update.locations !== undefined ? { locations: update.locations } : {}),
    ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
    ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
  };
}

interface AcpOpenToolCall {
  event: AcpToolCallUpdateEvent;
  clientFileWrites?: Extract<AcpToolCallContent, { type: "diff" }>[];
  openedType: ItemShape["type"];
  permissionTitle?: string;
  delegation?: AcpDelegationReport;
}

function planStepsPresentation(
  steps: readonly { step: string; status?: string }[],
): ThreadEventItemPresentation {
  const active = steps.find((step) => step.status === "active");
  return { ...labels.planSteps(active?.step), suppress: true };
}

export function createAcpTranslator(options: AcpTranslatorOptions) {
  const dialect = options.dialect ?? GENERIC_ACP_DIALECT;
  const pathOptions = { cwd: options.cwd };
  const context: AcpTranslationScope = { threadId: options.threadId };
  const mergedToolCalls = new Map<string, AcpOpenToolCall>();
  const writer = (): AcpEventWriter | undefined => {
    const events = options.events();
    return events === undefined ? undefined : acpEventWriterFor(events);
  };

  let lastUsageCost: ThreadUsageCost | undefined;
  let lastAgentTitle: string | undefined;

  let injectedToolsByName = new Map<string, AcpInjectedTool>();
  const injectedToolBindings = new Map<string, AcpInjectedTool>();
  const pendingInjectedCalls = new Map<string, AcpInjectedTool[]>();

  function callKey(
    context: AcpTranslationScope | undefined,
    toolCallId: string,
  ): string {
    return `${context?.threadId ?? ""} ${toolCallId}`;
  }

  function threadCallEntries(
    context: AcpTranslationScope | undefined,
  ): [string, AcpOpenToolCall][] {
    const prefix = `${context?.threadId ?? ""} `;
    return [...mergedToolCalls.entries()].filter(([key]) =>
      key.startsWith(prefix),
    );
  }

  function withDialectIdentity(
    event: AcpToolCallUpdateEvent,
  ): AcpToolCallUpdateEvent {
    if (dialect.toolIdentity === undefined) {
      return event;
    }
    const identity = dialect.toolIdentity(event);
    if (identity === undefined) {
      return event;
    }
    return {
      ...event,
      ...(event.kind === undefined && identity.kind !== undefined
        ? { kind: identity.kind }
        : {}),
      ...(event.name === undefined && identity.name !== undefined
        ? { name: identity.name }
        : {}),
    };
  }

  function clearThreadCalls(context: AcpTranslationScope | undefined): void {
    for (const [key] of threadCallEntries(context)) {
      mergedToolCalls.delete(key);
      injectedToolBindings.delete(key);
    }
    pendingInjectedCalls.delete(context?.threadId ?? "");
  }

  function configureInjectedTools(tools: readonly AcpInjectedTool[]): void {
    injectedToolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  }

  function injectedToolNamedBy(
    event: AcpToolCallUpdateEvent,
  ): AcpInjectedTool | undefined {
    const title = event.title;
    if (title === undefined || injectedToolsByName.size === 0) {
      return undefined;
    }
    for (const tool of injectedToolsByName.values()) {
      if (title.includes(tool.name)) {
        return tool;
      }
    }
    return undefined;
  }

  function bindAnnouncedCall(
    context: AcpTranslationScope | undefined,
    event: AcpToolCallUpdateEvent,
  ): AcpInjectedTool | undefined {
    if (!isInjectedToolCandidate(event)) {
      return undefined;
    }
    const named = injectedToolNamedBy(event);
    if (named !== undefined) {
      return named;
    }
    return pendingInjectedCalls.get(context?.threadId ?? "")?.shift();
  }

  function noteInjectedToolCall(threadId: string, toolName: string): void {
    const tool = injectedToolsByName.get(toolName) ?? { name: toolName };
    const candidates = threadCallEntries({ threadId }).filter(
      ([key, open]) =>
        !injectedToolBindings.has(key) && isInjectedToolCandidate(open.event),
    );
    const chosen =
      candidates.find(([, open]) => open.event.title?.includes(tool.name)) ??
      candidates.find(([, open]) => /\bmcp\b/i.test(open.event.title ?? "")) ??
      candidates[0];
    if (chosen !== undefined) {
      injectedToolBindings.set(chosen[0], tool);
      return;
    }
    const queue = pendingInjectedCalls.get(threadId) ?? [];
    queue.push(tool);
    pendingInjectedCalls.set(threadId, queue);
  }

  function classifyCall(
    context: AcpTranslationScope | undefined,
    event: AcpToolCallUpdateEvent,
  ): AcpClassifiedToolCall {
    const injected = injectedToolBindings.get(
      callKey(context, event.toolCallId),
    );
    if (injected === undefined) {
      const dialectShape = dialect.classifyToolCall?.(event);
      if (dialectShape !== undefined) {
        return dialectShape;
      }
    }
    return classifyAcpToolCall(event, injected, pathOptions);
  }

  interface AcpFsWriteSnapshot {
    path: string;
    oldText?: string;
    content: string;
  }

  function withClientFileWrites(
    event: AcpToolCallUpdateEvent,
    writes: readonly Extract<AcpToolCallContent, { type: "diff" }>[],
  ): AcpToolCallUpdateEvent {
    if (writes.length === 0) {
      return event;
    }
    const paths = new Set(
      writes.map((write) => resolveAcpToolCallPath(write.path, pathOptions)),
    );
    return {
      ...event,
      content: [
        ...(event.content ?? []).filter(
          (entry) =>
            entry.type !== "diff" ||
            !paths.has(resolveAcpToolCallPath(entry.path, pathOptions)),
        ),
        ...writes,
      ],
    };
  }

  function mergeFsWriteIntoOpenToolCall(
    context: AcpTranslationScope | undefined,
    write: AcpFsWriteSnapshot,
  ): boolean {
    const writePath = resolveAcpToolCallPath(write.path, pathOptions);
    const fileChangeCalls = threadCallEntries(context).flatMap(
      ([key, open]) => {
        if (open.openedType !== "fileChange") {
          return [];
        }
        const classified = classifyCall(context, open.event);
        return classified.item.type === "fileChange"
          ? [
              {
                key,
                open,
                paths: classified.item.changes.map((change) => change.path),
              },
            ]
          : [];
      },
    );
    const exactMatches = fileChangeCalls.filter(({ paths }) =>
      paths.includes(writePath),
    );
    const pathPendingMatches = fileChangeCalls.filter(
      ({ paths }) => paths.length === 0,
    );
    const matching =
      exactMatches.length === 1
        ? exactMatches[0]
        : exactMatches.length === 0 && pathPendingMatches.length === 1
          ? pathPendingMatches[0]
          : undefined;
    if (matching === undefined) {
      return false;
    }

    const previous = matching.open.clientFileWrites?.find(
      (entry) => resolveAcpToolCallPath(entry.path, pathOptions) === writePath,
    );
    const oldText = previous === undefined ? write.oldText : previous.oldText;
    const diff: Extract<AcpToolCallContent, { type: "diff" }> = {
      type: "diff",
      path: write.path,
      ...(oldText === undefined ? {} : { oldText }),
      newText: write.content,
    };
    const clientFileWrites = [
      ...(matching.open.clientFileWrites ?? []).filter(
        (entry) =>
          resolveAcpToolCallPath(entry.path, pathOptions) !== writePath,
      ),
      diff,
    ];
    mergedToolCalls.set(matching.key, {
      ...matching.open,
      clientFileWrites,
      event: withClientFileWrites(matching.open.event, clientFileWrites),
    });
    return true;
  }

  function closeThoughtStream(out: AcpEventWriter | undefined): void {
    out?.textClose({ channel: THOUGHT_STREAM_KEY }, "reasoningText");
  }

  function closeAssistantStream(out: AcpEventWriter | undefined): void {
    out?.textClose({ channel: ASSISTANT_STREAM_KEY }, "agentMessage");
  }

  interface AcpCloseArgs {
    event: AcpToolCallUpdateEvent;
    status: ThreadEventItemStatus;
    permissionTitle?: string | undefined;
    delegation?: AcpDelegationReport | undefined;
  }

  function withDelegationReport(
    classified: AcpClassifiedToolCall,
    report: AcpDelegationReport | undefined,
  ): AcpClassifiedToolCall {
    if (report === undefined || classified.item.type !== "delegation") {
      return classified;
    }
    return {
      item: {
        ...classified.item,
        childRef: report.childRef,
        label: report.label,
      },
      presentation: delegationPresentation({
        label: report.label,
        ...(report.detail === undefined ? {} : { detail: report.detail }),
      }),
    };
  }

  function withPermissionTitle(
    classified: AcpClassifiedToolCall,
    permissionTitle: string | undefined,
  ): AcpClassifiedToolCall {
    const title =
      permissionTitle === undefined
        ? undefined
        : presentationTitle(permissionTitle);
    return title === undefined
      ? classified
      : {
          item: classified.item,
          presentation: { ...classified.presentation, title },
        };
  }

  function closeToolCall(
    out: AcpEventWriter | undefined,
    args: AcpCloseArgs,
  ): void {
    const classified = withPermissionTitle(
      withDelegationReport(classifyCall(context, args.event), args.delegation),
      args.permissionTitle,
    );
    injectedToolBindings.delete(callKey(context, args.event.toolCallId));
    const closeFields =
      classified.item.type === "commandExecution"
        ? commandCloseFields(args.event, args.status)
        : genericCloseFields(args.event);
    out?.closeItem({ providerItemId: args.event.toolCallId }, classified.item, {
      status: args.status,
      ...closeFields,
      presentation: classified.presentation,
    });
  }

  function commandCloseFields(
    event: AcpToolCallUpdateEvent,
    status: ThreadEventItemStatus,
  ): AcpItemResult {
    const normalizedEvent = dialect.normalizeCommandEvent?.(event) ?? event;
    const result =
      dialect.commandResult?.(normalizedEvent) ??
      extractAcpCommandResult(normalizedEvent);
    const exitCode = result.exitCode ?? (status === "failed" ? 1 : undefined);
    return {
      ...(result.output === undefined
        ? {}
        : { aggregatedOutput: result.output, resultText: result.output }),
      ...(exitCode === undefined ? {} : { exitCode }),
    };
  }

  function genericCloseFields(event: AcpToolCallUpdateEvent): AcpItemResult {
    const outputText = extractAcpToolCallOutputText(event);
    return outputText === undefined ? {} : { resultText: outputText };
  }

  function drainOpenToolCalls(
    out: AcpEventWriter | undefined,
    status: ThreadEventItemStatus,
  ): void {
    for (const [key, open] of threadCallEntries(context)) {
      mergedToolCalls.delete(key);
      closeToolCall(out, {
        event: open.event,
        status,
        permissionTitle: open.permissionTitle,
        delegation: open.delegation,
      });
    }
  }

  function flushOpenTurnWork(
    out: AcpEventWriter | undefined,
    status: ThreadEventItemStatus,
  ): void {
    closeThoughtStream(out);
    closeAssistantStream(out);
    drainOpenToolCalls(out, status);
  }

  function update(update: AcpSessionUpdate): void {
    const out = writer();
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const parsed = acpAgentMessageChunkUpdateSchema.safeParse(update);
        const text = parsed.success
          ? extractAcpContentText(parsed.data.content)
          : undefined;
        if (text === undefined) {
          return;
        }
        closeThoughtStream(out);
        out?.textDelta({ channel: ASSISTANT_STREAM_KEY }, "agentMessage", text);
        return;
      }

      case "agent_thought_chunk": {
        const parsed = acpAgentThoughtChunkUpdateSchema.safeParse(update);
        const text = parsed.success
          ? extractAcpContentText(parsed.data.content)
          : undefined;
        if (text === undefined) {
          return;
        }
        out?.textDelta({ channel: THOUGHT_STREAM_KEY }, "reasoningText", text);
        return;
      }

      case "tool_call": {
        const parsed = acpToolCallUpdateEventSchema.safeParse(update);
        if (!parsed.success) {
          return;
        }
        const event = withDialectIdentity(parsed.data);
        const announcedKey = callKey(context, event.toolCallId);
        const bound = bindAnnouncedCall(context, event);
        if (bound !== undefined) {
          injectedToolBindings.set(announcedKey, bound);
        }
        closeThoughtStream(out);
        closeAssistantStream(out);
        if (isTerminalAcpStatus(event.status)) {
          closeToolCall(out, {
            event,
            status: mapAcpToolCallStatus(event.status),
          });
          return;
        }
        const classified = classifyCall(context, event);
        mergedToolCalls.set(announcedKey, {
          event,
          openedType: classified.item.type,
        });
        out?.openItem(
          { providerItemId: event.toolCallId },
          classified.item,
          classified.presentation,
        );
        return;
      }

      case "tool_call_update": {
        const parsed = acpToolCallUpdateEventSchema.safeParse(update);
        if (!parsed.success) {
          return;
        }
        const event = withDialectIdentity(parsed.data);
        const key = callKey(context, event.toolCallId);
        const open = mergedToolCalls.get(key);
        const merged = withClientFileWrites(
          mergeAcpToolCallEvents(open?.event, event),
          open?.clientFileWrites ?? [],
        );
        if (isTerminalAcpStatus(merged.status)) {
          mergedToolCalls.delete(key);
          closeToolCall(out, {
            event: merged,
            status: mapAcpToolCallStatus(merged.status),
            permissionTitle: open?.permissionTitle,
            delegation: open?.delegation,
          });
          return;
        }
        const mergedType = classifyCall(context, merged).item.type;
        mergedToolCalls.set(key, {
          event: merged,
          openedType: open?.openedType ?? mergedType,
          ...(open?.permissionTitle === undefined
            ? {}
            : { permissionTitle: open.permissionTitle }),
          ...(open?.delegation === undefined
            ? {}
            : { delegation: open.delegation }),
          ...(open?.clientFileWrites === undefined
            ? {}
            : { clientFileWrites: open.clientFileWrites }),
        });
        if (
          event.status === "in_progress" &&
          mergedType === "commandExecution" &&
          open?.openedType === "commandExecution"
        ) {
          const normalizedEvent =
            dialect.normalizeCommandEvent?.(event) ?? event;
          const streamed = extractAcpStreamedCommandOutput(normalizedEvent);
          if (streamed !== undefined) {
            out?.commandOutput({ providerItemId: event.toolCallId }, streamed);
          }
          return;
        }
        const progressText = extractAcpToolCallOutputText(event);
        if (
          progressText !== undefined &&
          mergedType !== "commandExecution" &&
          mergedType !== "fileChange"
        ) {
          out?.progress({ providerItemId: event.toolCallId }, progressText);
        }
        return;
      }

      case "plan": {
        const parsed = acpPlanUpdateSchema.safeParse(update);
        if (!parsed.success) {
          return;
        }
        const steps: ThreadEventPlanStep[] = parsed.data.entries.map(
          (entry) => ({
            step: entry.content,
            ...(entry.status
              ? { status: ACP_PLAN_STEP_STATUS_BY_ENTRY_STATUS[entry.status] }
              : {}),
          }),
        );
        out?.closeItem(
          { channel: PLAN_STEPS_CHANNEL },
          { type: "planSteps", steps },
          { status: "completed", presentation: planStepsPresentation(steps) },
        );
        return;
      }

      case "usage_update": {
        const parsed = acpUsageUpdateSchema.safeParse(update);
        if (!parsed.success) {
          return;
        }
        const cost = threadUsageCostSchema.safeParse(parsed.data["cost"]);
        if (cost.success) {
          lastUsageCost = cost.data;
        }
        out?.events.contextWindow(
          {
            usedTokens: parsed.data.used,
            modelContextWindow: parsed.data.size,
            estimated: false,
            ...(lastUsageCost === undefined ? {} : { cost: lastUsageCost }),
          },
          undefined,
          true,
        );
        return;
      }

      case "session_info_update": {
        const title = isJsonObject(update) ? update["title"] : undefined;
        if (
          typeof title !== "string" ||
          title.trim() === "" ||
          title === lastAgentTitle
        ) {
          return;
        }
        lastAgentTitle = title;
        out?.events.name(title, "agent");
        return;
      }

      default:
        return;
    }
  }

  function turnStatusForStopReason(
    stopReason: AcpStopReason,
  ): ThreadEventTurnStatus {
    return stopReason === "cancelled" ? "interrupted" : "completed";
  }

  function stopReasonNotice(
    stopReason: AcpStopReason,
  ): { summary: string; details?: string } | undefined {
    switch (stopReason) {
      case "end_turn":
      case "cancelled":
        return undefined;
      case "max_tokens":
        return {
          summary: "The agent stopped at its output limit",
          details:
            "The model reached its maximum output length before finishing this turn.",
        };
      case "max_turn_requests":
        return {
          summary: "The agent stopped at its request limit",
          details:
            "The agent reached its limit of model requests for a single turn.",
        };
      case "refusal":
        return { summary: "The agent declined to continue" };
      default:
        return {
          summary: "The agent stopped the turn",
          details: `Stop reason: ${stopReason}`,
        };
    }
  }

  function itemStatusForTurnStatus(
    status: ThreadEventTurnStatus,
  ): ThreadEventItemStatus {
    return status === "completed"
      ? "completed"
      : status === "interrupted"
        ? "interrupted"
        : "failed";
  }

  function turnStarted(): void {
    clearThreadCalls(context);
    writer()?.openTurn();
  }

  function turnCompleted(stopReason: AcpStopReason): void {
    const out = writer();
    const status = turnStatusForStopReason(stopReason);
    const notice = stopReasonNotice(stopReason);
    flushOpenTurnWork(out, itemStatusForTurnStatus(status));
    if (notice !== undefined) {
      out?.events.warning({
        summary: notice.summary,
        ...(notice.details === undefined ? {} : { details: notice.details }),
      });
    }
    out?.closeTurn({ status, claimIfIdle: true });
  }

  function compactionStarted(): void {
    clearThreadCalls(context);
    const out = writer();
    out?.openTurn();
    out?.openItem(
      { channel: "compaction" },
      { type: "contextCompaction" },
      labels.compaction,
    );
  }

  function compactionCompleted(outcome: AcpCompactionOutcome): void {
    const reason =
      outcome.status === "skipped"
        ? outcome.detail
        : outcome.status === "failed"
          ? outcome.error
          : undefined;
    if (reason === "") {
      return;
    }
    const out = writer();
    const turnStatus: ThreadEventTurnStatus =
      outcome.status === "skipped" ? "completed" : outcome.status;
    flushOpenTurnWork(out, itemStatusForTurnStatus(turnStatus));
    if (outcome.status === "completed") {
      out?.events.compacted({});
    }
    if (outcome.status === "skipped") {
      out?.events.warning({
        summary: "Context compaction skipped",
        details: outcome.detail,
        category: "compaction-skipped",
      });
    }
    out?.closeTurn({
      status: turnStatus,
      ...(outcome.status === "failed" ? { error: outcome.error } : {}),
    });
  }

  function fileWritten(write: AcpFileWrite): void {
    if (write.path === "" || mergeFsWriteIntoOpenToolCall(context, write)) {
      return;
    }
    const diff = buildEditDiff(write.path, write.oldText, write.content);
    writer()?.closeItem(
      { channel: "fs-write" },
      {
        type: "fileChange",
        changes: [
          {
            path: write.path,
            kind: write.kind,
            ...(diff === undefined ? {} : { diff }),
          },
        ],
      },
      {
        status: "completed",
        presentation: fileChangePresentation({
          verb: write.kind,
          paths: [write.path],
        }),
      },
    );
  }

  function warning(notice: { summary: string; details?: string }): void {
    if (notice.summary === "") {
      return;
    }
    writer()?.events.warning({
      summary: notice.summary,
      ...(notice.details ? { details: notice.details } : {}),
    });
  }

  function failed(message: string): void {
    clearThreadCalls(context);
    writer()?.events.error(
      { message: "Provider error", detail: message },
      { settlesTurn: true },
    );
  }

  function inputAccepted(clientRequestId: string): void {
    writer()?.acceptInput(clientRequestId);
  }

  function notePermissionToolCall(
    threadId: string,
    toolCall: AcpPermissionToolCallInput,
  ): AcpBoundPermissionToolCall {
    const context = { threadId };
    const ownKey = callKey(context, toolCall.toolCallId);
    let boundKey: string | undefined = mergedToolCalls.has(ownKey)
      ? ownKey
      : undefined;
    if (boundKey === undefined) {
      const sameKind = threadCallEntries(context).filter(
        ([, open]) =>
          toolCall.kind !== undefined && open.event.kind === toolCall.kind,
      );
      boundKey = sameKind.length === 1 ? sameKind[0]?.[0] : undefined;
    }
    const open =
      boundKey === undefined ? undefined : mergedToolCalls.get(boundKey);
    if (boundKey === undefined || open === undefined) {
      return { toolCallId: toolCall.toolCallId, event: undefined };
    }
    if (classifyCall(context, open.event).item.type !== "toolCall") {
      return { toolCallId: open.event.toolCallId, event: open.event };
    }
    const kind =
      toolCall.kind !== undefined &&
      (toolCall.kind !== "other" || open.event.kind === undefined)
        ? toolCall.kind
        : undefined;
    const merged = mergeAcpToolCallEvents(open.event, {
      sessionUpdate: "tool_call_update",
      toolCallId: open.event.toolCallId,
      ...(toolCall.title !== undefined ? { title: toolCall.title } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(kind === "other" && toolCall.rawKind !== undefined
        ? { rawKind: toolCall.rawKind }
        : {}),
      ...(toolCall.locations !== undefined
        ? { locations: toolCall.locations }
        : {}),
      ...(toolCall.rawInput !== undefined
        ? { rawInput: toolCall.rawInput }
        : {}),
      ...(toolCall.rawOutput !== undefined
        ? { rawOutput: toolCall.rawOutput }
        : {}),
    });
    if (classifyCall(context, merged).item.type === open.openedType) {
      mergedToolCalls.set(boundKey, { ...open, event: merged });
      return { toolCallId: merged.toolCallId, event: merged };
    }
    mergedToolCalls.set(boundKey, {
      ...open,
      ...(toolCall.title === undefined
        ? {}
        : { permissionTitle: toolCall.title }),
    });
    return { toolCallId: open.event.toolCallId, event: merged };
  }

  function noteDelegationReport(
    threadId: string,
    report: AcpDelegationReport,
  ): void {
    const context = { threadId };
    const key = callKey(context, report.toolCallId);
    const open = mergedToolCalls.get(key);
    if (open === undefined) {
      return;
    }
    const classified = classifyCall(context, open.event);
    if (classified.item.type !== "delegation") {
      return;
    }
    const item: ItemShape = {
      ...classified.item,
      childRef: report.childRef,
      label: report.label,
    };
    mergedToolCalls.set(key, { ...open, delegation: report });
    writer()?.openItem(
      { providerItemId: report.toolCallId },
      item,
      delegationPresentation({
        label: report.label,
        ...(report.detail === undefined ? {} : { detail: report.detail }),
      }),
    );
  }

  function getInjectedToolBinding(
    threadId: string,
    toolCallId: string,
  ): AcpInjectedTool | undefined {
    return injectedToolBindings.get(callKey({ threadId }, toolCallId));
  }

  return {
    compactionCompleted,
    compactionStarted,
    configureInjectedTools,
    failed,
    fileWritten,
    getInjectedToolBinding,
    inputAccepted,
    noteDelegationReport,
    noteInjectedToolCall,
    notePermissionToolCall,
    turnCompleted,
    turnStarted,
    update,
    warning,
  };
}

export type AcpTranslator = ReturnType<typeof createAcpTranslator>;
