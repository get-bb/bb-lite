import type {
  ExtensionKind,
  JsonValue,
  ThreadEventItemStatus,
  ThreadEventPlanStep,
  ThreadEventTurnStatus,
  ThreadUsageCost,
} from "@bb/domain";
import {
  buildEditDiff,
  type EventBuilder,
  type ItemKey,
  type ItemShape,
} from "@bb/runner";
import type { DeltaPresentation } from "./kit.js";

export type { DeltaPresentation } from "./kit.js";

export interface DeltaFileChange {
  path: string;
  kind: "add" | "update" | "delete";
  movePath?: string;
  diff?: string;
  oldText?: string;
  newText?: string;
}

export type DeltaItemShape =
  | {
      type: "command";
      command: string;
      cwd: string;
      aggregatedOutput?: string;
      exitCode?: number;
      durationMs?: number;
    }
  | { type: "fileChange"; changes: DeltaFileChange[] }
  | {
      type: "tool";
      tool: string;
      server?: string;
      args?: unknown;
      result?: unknown;
      error?: string;
      durationMs?: number;
    }
  | { type: "compaction" }
  | { type: "agentMessage"; text: string }
  | { type: "reasoning"; summary: string[]; content: string[] }
  | { type: "plan"; text: string }
  | { type: "webSearch"; queries: string[] }
  | {
      type: "webFetch";
      url: string;
      prompt?: string | null;
      pattern: string | null;
    }
  | { type: "fileRead"; path: string; cmd?: string }
  | {
      type: "search";
      mode: "content" | "path" | "list";
      query: string;
      path?: string;
      cmd?: string;
    }
  | {
      type: "delegation";
      childRef: string;
      label: string;
      background: boolean;
      summary?: string;
    }
  | {
      type: "planSteps";
      steps: ThreadEventPlanStep[];
      explanation?: string;
    };

export interface DeltaNoTurnFallback {
  raw: unknown;
  rawType: string;
}

type TextChannel =
  | "agentMessage"
  | "reasoningSummary"
  | "reasoningText"
  | "plan";

interface Scoped {
  providerTurnId?: string;
  noTurnFallback?: DeltaNoTurnFallback;
}

export type ThreadDelta =
  | { kind: "input.accepted"; clientRequestId: string }
  | { kind: "turn.open"; providerTurnId?: string; parentRef?: string }
  | {
      kind: "turn.boundary";
      status: ThreadEventTurnStatus;
      error?: { message: string };
      providerCheckpointId?: string;
      claimIfIdle?: boolean;
      providerTurnId?: string;
    }
  | ({
      kind: "item.open";
      key: ItemKey;
      item: DeltaItemShape;
      presentation?: DeltaPresentation;
    } & Scoped)
  | ({
      kind: "item.close";
      key: ItemKey;
      status: ThreadEventItemStatus;
      resultText?: string;
      exitCode?: number;
      aggregatedOutput?: string;
      approvalStatus?: "denied";
      item: DeltaItemShape;
      presentation?: DeltaPresentation;
    } & Scoped)
  | ({
      kind: "item.progress";
      key: ItemKey;
      message?: string;
      flush?: boolean;
    } & Scoped)
  | ({
      kind: "item.textDelta";
      key: ItemKey;
      channel: TextChannel;
      text: string;
    } & Scoped)
  | ({
      kind: "item.textClose";
      key: ItemKey;
      channel: TextChannel;
      text?: string;
    } & Scoped)
  | ({
      kind: "item.outputDelta";
      key: ItemKey;
      channel: "command" | "fileChange";
      text: string;
    } & Scoped)
  | ({ kind: "command.outputSnapshot"; key: ItemKey; text: string } & Scoped)
  | {
      kind: "contextWindow";
      used: number | null;
      size?: number | null;
      estimated: boolean;
      cost?: ThreadUsageCost;
      attach: "open" | "currentOrLast";
    }
  | ({ kind: "context.compacted" } & Scoped)
  | { kind: "thread.name"; name: string; source?: "agent" }
  | {
      kind: "extension.state";
      extensionKind: ExtensionKind;
      payload: JsonValue;
    }
  | {
      kind: "provider.error";
      message: string;
      detail?: string;
      willRetry?: boolean;
      settlesTurn?: boolean;
      threadScoped?: boolean;
    }
  | {
      kind: "provider.warning";
      summary?: string;
      details?: string;
      category?: "deprecation" | "config" | "general" | "compaction-skipped";
      vouchedTurn?: boolean;
    }
  | {
      kind: "unhandled";
      raw: unknown;
      rawType: string;
      vouchedTurn: boolean;
      onlyIfNoTurn?: boolean;
      parentRef?: string;
    }
  | { kind: "session.reset" };

type CloseFields = Pick<
  Extract<ThreadDelta, { kind: "item.close" }>,
  "resultText" | "exitCode" | "aggregatedOutput"
>;

function defined<T extends object>(value: T): T {
  const kept = Object.entries(value).filter(([, v]) => v !== undefined);
  return Object.fromEntries(kept) as T;
}

function argumentsOf(args: unknown): Record<string, unknown> | undefined {
  const plain =
    typeof args === "object" && args !== null && !Array.isArray(args);
  return plain ? (args as Record<string, unknown>) : undefined;
}

function fileChange(change: DeltaFileChange) {
  const { path, kind, movePath, oldText, newText } = change;
  const diff = change.diff ?? buildEditDiff(path, oldText, newText);
  return defined({ path, kind, movePath, diff });
}

export function toItemShape(
  item: DeltaItemShape,
  close: CloseFields = {},
): ItemShape {
  switch (item.type) {
    case "command":
      return defined({
        type: "commandExecution" as const,
        command: item.command,
        cwd: item.cwd,
        aggregatedOutput: close.aggregatedOutput ?? item.aggregatedOutput,
        exitCode: close.exitCode ?? item.exitCode,
        durationMs: item.durationMs,
      });
    case "fileChange":
      return { type: "fileChange", changes: item.changes.map(fileChange) };
    case "tool":
      return defined({
        type: "toolCall" as const,
        tool: item.tool,
        server: item.server,
        arguments: argumentsOf(item.args),
        result: item.result ?? close.resultText,
        error: item.error,
        durationMs: item.durationMs,
      });
    case "compaction":
      return { type: "contextCompaction" };
    case "webSearch":
      return { ...item, resultText: close.resultText ?? null };
    case "webFetch":
      return {
        type: "webFetch",
        url: item.url,
        prompt: item.prompt ?? null,
        pattern: item.pattern,
        resultText: close.resultText ?? null,
      };
    default:
      return item;
  }
}

export interface DeltaSink {
  apply(deltas: readonly ThreadDelta[]): void;
}

export function createDeltaSink(events: EventBuilder): DeltaSink {
  let unclaimedInputs = 0;
  const openShapes = new Map<string, ItemShape>();
  const commandOutput = new Map<string, string>();
  const shapeKey = (key: ItemKey) =>
    [key.providerItemId, key.channel, key.parentRef].join("\u001f");

  function one(delta: ThreadDelta): void {
    const turn = "providerTurnId" in delta ? delta.providerTurnId : undefined;
    const target = turn === undefined ? {} : { turn };
    switch (delta.kind) {
      case "input.accepted":
        if (events.activeTurnId === null) unclaimedInputs += 1;
        events.acceptInput(delta.clientRequestId);
        return;
      case "turn.open":
        unclaimedInputs = 0;
        events.openTurn({ ...target, parentRef: delta.parentRef });
        return;
      case "turn.boundary": {
        const idle = events.activeTurnId === null && turn === undefined;
        if (idle && delta.claimIfIdle && unclaimedInputs > 0) {
          unclaimedInputs = 0;
          events.openTurn();
        }
        openShapes.clear();
        commandOutput.clear();
        events.closeTurn({
          ...target,
          status: delta.status,
          error: delta.error?.message,
          checkpointId: delta.providerCheckpointId,
        });
        return;
      }
      case "item.open": {
        const { presentation } = delta;
        const options = { ...target, presentation };
        const shape = toItemShape(delta.item);
        openShapes.set(shapeKey(delta.key), shape);
        events.openItem(delta.key, shape, options);
        return;
      }
      case "item.close": {
        const shape = toItemShape(delta.item, delta);
        const stale = openShapes.get(shapeKey(delta.key));
        openShapes.delete(shapeKey(delta.key));
        commandOutput.delete(shapeKey(delta.key));
        const { status, presentation } = delta;
        const denied = delta.approvalStatus === "denied";
        const closing = { ...target, status, presentation, denied };
        if (stale === undefined || stale.type === shape.type) {
          events.closeItem(delta.key, shape, closing);
          return;
        }
        const channel = `${delta.key.channel ?? "item"}:${shape.type}`;
        const retyped = { ...delta.key, providerItemId: undefined, channel };
        events.closeItem(delta.key, stale, { ...target, status });
        events.openItem(retyped, shape, { ...target, presentation });
        events.closeItem(retyped, shape, closing);
        return;
      }
      case "item.progress": {
        const { message, flush } = delta;
        events.progress(delta.key, { ...target, message, flush });
        return;
      }
      case "item.textDelta":
      case "item.outputDelta":
        events.delta(delta.key, delta.channel, delta.text, target);
        return;
      case "item.textClose":
        events.textClose(delta.key, delta.channel, delta.text, target);
        return;
      case "command.outputSnapshot": {
        const key = shapeKey(delta.key);
        const sent = commandOutput.get(key);
        commandOutput.set(key, delta.text);
        if (sent === undefined || !delta.text.startsWith(sent)) {
          events.commandOutput(delta.key, delta.text, target);
        } else if (delta.text.length > sent.length) {
          const fresh = delta.text.slice(sent.length);
          events.delta(delta.key, "command", fresh, target);
        }
        return;
      }
      case "contextWindow":
        events.contextWindow(
          {
            usedTokens: delta.used,
            modelContextWindow: delta.size ?? null,
            estimated: delta.estimated,
            ...(delta.cost === undefined ? {} : { cost: delta.cost }),
          },
          undefined,
          delta.attach === "open",
        );
        return;
      case "context.compacted":
        events.compacted(target);
        return;
      case "thread.name":
        events.name(delta.name, delta.source);
        return;
      case "extension.state":
        events.extensionState(delta.extensionKind, delta.payload);
        return;
      case "provider.error": {
        const { message, detail, willRetry, settlesTurn, threadScoped } = delta;
        const report = defined({ message, detail, willRetry });
        events.error(report, { settlesTurn, threadScoped });
        return;
      }
      case "provider.warning": {
        const { summary, details, category } = delta;
        events.warning(defined({ summary, details, category }));
        return;
      }
      case "unhandled":
      case "session.reset":
        return;
    }
  }

  return {
    apply(deltas) {
      for (const delta of deltas) one(delta);
    },
  };
}
