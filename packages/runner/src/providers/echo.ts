import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  reasoningEffortsForLevels,
  type AvailableModel,
  type PendingInteractionPayload as Payload,
  type PromptInput,
  type ThreadEventItemPresentation as Presentation,
} from "@bb/domain";
import { z } from "zod";
import type { ItemShape } from "../events/event-builder.js";
import type { SessionSpec } from "../types.js";
import * as ui from "./provider.js";
import type {
  ProviderAdapter,
  ProviderSession,
  SessionHost,
  TurnInput,
} from "./provider.js";

interface Turn {
  key: string;
  bbId: string;
  text: string;
  cancelled: boolean;
}

const stateSchema = z.object({
  providerThreadId: z.string(),
  turns: z.number(),
});
const answer = z.object({
  selected: z.array(z.string()),
  freeText: z.string(),
});
const answerSchema = z.object({
  answers: z.record(z.string(), answer.partial()),
});
const toolInputSchema = z.record(z.string(), z.unknown());
const CONTEXT_WINDOW = 200_000;
const EFFORTS = reasoningEffortsForLevels(["low", "medium", "high"]);
const MODELS: AvailableModel[] = ["echo-1", "echo-2"].map((id, index) => ({
  id,
  model: id,
  displayName: index === 0 ? "Echo" : "Echo Two",
  description: "Scripted provider for development and tests",
  supportedReasoningEfforts: EFFORTS,
  defaultReasoningEffort: "medium",
  isDefault: index === 0,
}));

function directive(text: string, name: string) {
  const pattern = new RegExp(`(?:^|\\s)${name}(?::(\\S+))?(?=\\s|$)`, "u");
  const match = pattern.exec(text);
  return match === null ? undefined : (match[1] ?? "").replaceAll("_", " ");
}

function promptText(input: readonly PromptInput[]) {
  return input
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join(" ");
}

function approvalPayload(itemId: string) {
  const availableDecisions = ["allow_once" as const, "deny" as const];
  const base = { kind: "approval" as const, reason: null, availableDecisions };
  const command = { command: "echo hi", cwd: null, actions: [] };
  const subject = { kind: "command" as const, itemId, ...command };
  return { ...base, subject: { ...subject, sessionGrant: null } };
}

function questionPayload(turn: string): Payload {
  const option = (label: string, description: string) => ({
    value: label.toLowerCase(),
    label,
    description,
  });
  const options = [
    option("Staging", "Deploy to staging first."),
    option("Production", "Deploy directly to production."),
  ];
  const prompt = "Which deployment path should the echo provider use?";
  const meta = { shortLabel: "Path", multiSelect: false, allowFreeText: true };
  const question = { id: `${turn}:question-1`, prompt, options, ...meta };
  return { kind: "user_question", questions: [question] };
}

class EchoSession implements ProviderSession {
  private active: Turn | null = null;
  private timers = new Set<NodeJS.Timeout>();

  constructor(
    readonly providerThreadId: string,
    private turns: number,
    private readonly spec: SessionSpec,
    private readonly host: SessionHost,
  ) {}

  canApply(spec: SessionSpec) {
    return spec.cwd === this.spec.cwd;
  }

  async startTurn({ clientRequestId, input }: TurnInput) {
    const text = promptText(input);
    this.turns += 1;
    const { providerThreadId, turns } = this;
    const path = join(this.host.threadStorageDir, "echo-state.json");
    await writeFile(path, JSON.stringify({ providerThreadId, turns }));
    if (directive(text, "swallow_turn") !== undefined) return;
    this.host.events.acceptInput(clientRequestId);
    const key = `turn-${turns}`;
    const bbId = this.host.events.openTurn({ turn: key });
    this.active = { key, bbId, text, cancelled: false };
    const failed = (error: unknown) =>
      this.fail(key, `request failed: ${error}`);
    void this.run(this.active).catch(failed);
  }

  async steer(args: TurnInput & { expectedTurnId: string }) {
    const turn = this.active;
    if (turn === null || turn.bbId !== args.expectedTurnId) return "stale";
    const text = promptText(args.input);
    this.host.events.acceptInput(args.clientRequestId, { turn: turn.key });
    this.say(turn.key, `steer-${args.clientRequestId}`, `Steered: ${text}`);
    if (directive(text, "release_turn") !== undefined) this.finish(turn);
    return "steered";
  }

  async interrupt() {
    const turn = this.active;
    const ignored =
      turn && directive(turn.text, "ignore_interrupt") !== undefined;
    if (turn !== null && !ignored) this.finish(turn, "interrupted");
  }

  async close() {
    if (this.active !== null) this.active.cancelled = true;
    this.active = null;
    for (const timer of this.timers) clearTimeout(timer);
  }

  async rename(title: string) {
    this.host.events.name(title);
  }

  private item(
    turn: string,
    name: string,
    shape: ItemShape,
    label: Presentation,
  ) {
    const key = { providerItemId: `${turn}-${name}` };
    const options = { turn, presentation: label };
    const { events } = this.host;
    const id = events.openItem(key, shape, options) ?? key.providerItemId;
    const close = (final: ItemShape) =>
      events.closeItem(key, final, { ...options, status: "completed" });
    return { key, id, close };
  }

  private say(turn: string, id: string, text: string, parentRef?: string) {
    const key = { providerItemId: id, parentRef };
    const options = { turn, presentation: ui.labels.message };
    const shape = { type: "agentMessage" as const, text };
    this.host.events.openItem(key, { ...shape, text: "" }, options);
    this.host.events.closeItem(key, shape, { ...options, status: "completed" });
  }

  private finish(
    turn: Turn,
    status: "completed" | "interrupted" = "completed",
  ) {
    turn.cancelled = true;
    if (this.active === turn) this.active = null;
    const checkpointId = turn.key;
    this.host.events.closeTurn({ turn: turn.key, status, checkpointId });
  }

  private fail(turn: string, detail: string) {
    if (this.active?.key !== turn) return;
    this.active = null;
    const report = { detail, willRetry: false };
    this.host.events.error(report, { turn, settlesTurn: true });
  }

  private wait(turn: Turn, ms: number) {
    if (ms <= 0) return Promise.resolve(!turn.cancelled);
    return new Promise<boolean>((resolve) => {
      const done = () => resolve(this.timers.delete(timer) && !turn.cancelled);
      const timer = setTimeout(done, ms);
      this.timers.add(timer);
    });
  }

  private async interact(live: Turn) {
    const { host } = this;
    const { key: turn, bbId: turnId, text } = live;
    if (directive(text, "approve") !== undefined) {
      const payload = approvalPayload(`approval-${turn}`);
      const resolution = await host.requestInteraction({ payload, turnId });
      const denied =
        !("decision" in resolution) || resolution.decision === "deny";
      if (denied) return "Denied";
    }
    if (directive(text, "ask_user") !== undefined) {
      const payload = questionPayload(turn);
      const resolution = await host.requestInteraction({ payload, turnId });
      const parsed = answerSchema.safeParse(resolution);
      const first = parsed.success ? Object.values(parsed.data.answers)[0] : {};
      const parts = [...(first?.selected ?? []), first?.freeText ?? ""];
      const given = parts.filter((part) => part.length > 0).join(", ");
      return `Question answered: ${given || "no answer"}`;
    }
    const tool = directive(text, "call_tool");
    if (tool === undefined) return undefined;
    const encoded = directive(text, "tool_input") ?? "{}";
    const input = toolInputSchema.parse(JSON.parse(encoded));
    const shape = { type: "toolCall" as const, server: "bb", tool };
    const call = { ...shape, arguments: input };
    const item = this.item(turn, "call", call, ui.labels.tool(tool));
    const { id: callId, close } = item;
    const request = { callId, tool, arguments: input, turnId };
    const { contentItems } = await host.callTool(request);
    const texts = contentItems.flatMap((c) =>
      c.type === "inputText" ? [c.text] : [],
    );
    close({ ...call, result: texts.join("\n") });
    return `Tool called: ${tool}`;
  }

  private async run(live: Turn) {
    const { events } = this.host;
    const { key: turn, text } = live;
    const pace = Number(directive(text, "pace") ?? 0);
    const thought = directive(text, "think");
    if (thought !== undefined) {
      const empty = { type: "reasoning" as const, summary: [], content: [] };
      const item = this.item(turn, "think", empty, ui.labels.reasoning);
      events.delta(item.key, "reasoningText", thought, { turn });
      item.close({ ...empty, content: [thought] });
    }
    const command = directive(text, "cmd");
    if (command !== undefined) {
      const cwd = this.spec.cwd;
      const shape = { type: "commandExecution" as const, command, cwd };
      const item = this.item(turn, "cmd", shape, ui.labels.command(command));
      const output = [`$ ${command}\n`, "ok\n"];
      for (const chunk of output) {
        events.delta(item.key, "command", chunk, { turn });
        if (!(await this.wait(live, pace))) return;
      }
      const result = { aggregatedOutput: output.join(""), exitCode: 0 };
      item.close({ ...shape, ...result, durationMs: 1 });
    }
    const path = directive(text, "edit");
    if (path !== undefined) {
      const diff = ui.buildEditDiff(path, "before\n", "after\n");
      const changes = [{ path, kind: "update" as const, diff }];
      const shape = { type: "fileChange" as const, changes };
      this.item(turn, "edit", shape, ui.labels.fileChange([path])).close(shape);
    }
    const tool = directive(text, "tool");
    if (tool !== undefined) {
      const call = { type: "toolCall" as const, server: "echo", tool };
      const shape = { ...call, arguments: {} };
      const item = this.item(turn, "tool", shape, ui.labels.tool(tool, "echo"));
      events.progress(item.key, { turn, message: "working", flush: true });
      item.close({ ...shape, result: "ok", durationMs: 1 });
    }
    const label = directive(text, "subagent");
    if (label !== undefined) {
      const childTurn = `${turn}-child`;
      const agent = { type: "delegation" as const, label, childRef: childTurn };
      const shape = { ...agent, background: false };
      const item = this.item(turn, "agent", shape, ui.labels.agent(label));
      const parentRef = item.key.providerItemId;
      events.openTurn({ turn: childTurn, parentRef });
      const summary = `Subagent ${label} finished`;
      this.say(childTurn, `${turn}-agent-reply`, summary, parentRef);
      events.closeTurn({ turn: childTurn, status: "completed" });
      item.close({ ...shape, summary });
    }
    const outcome = await this.interact(live);
    if (live.cancelled) return;
    if (directive(text, "crash") !== undefined) {
      this.active = null;
      const message = "echo provider exited (code 1)";
      this.host.onExit({ message, stderrTail: "scripted crash" });
      return;
    }
    const failure = directive(text, "fail_turn");
    if (failure !== undefined) return this.fail(turn, failure);
    if (directive(text, "hold_turn") !== undefined) return;
    if (!(await this.wait(live, Number(directive(text, "delay") ?? 0)))) return;
    const counted = directive(text, "count") !== undefined;
    const echoed =
      text.length > 0 ? `Response to: ${text}` : "Response complete";
    const reply = outcome ?? (counted ? `Turn count: ${this.turns}` : echoed);
    const pieces = Number(directive(text, "stream") ?? 1);
    const size = Math.ceil(reply.length / pieces);
    const empty = { type: "agentMessage" as const, text: "" };
    const item = this.item(turn, "reply", empty, ui.labels.message);
    for (let offset = 0; offset < reply.length; offset += Math.max(1, size)) {
      const delta = reply.slice(offset, offset + Math.max(1, size));
      events.delta(item.key, "agentMessage", delta, { turn });
      if (!(await this.wait(live, pace))) return;
    }
    item.close({ ...empty, text: reply });
    const tokens = Number(directive(text, "usage") ?? 100 + text.length);
    const last = {
      ...ui.ZERO_TOKEN_USAGE,
      totalTokens: tokens,
      inputTokens: tokens,
    };
    const total = { ...last, totalTokens: tokens * this.turns };
    const modelContextWindow = CONTEXT_WINDOW;
    events.usage({ total, last, modelContextWindow }, { turn });
    const window = { usedTokens: tokens, modelContextWindow, estimated: false };
    events.contextWindow(window, { turn });
    this.finish(live);
  }
}

export function createEchoAdapter(): ProviderAdapter {
  const ready = { installed: true, auth: "ready" as const, message: null };
  const identity = { providerId: "echo" as const, executablePath: null };
  const status = { ...identity, ...ready };
  return {
    id: "echo",
    approvalEnforcedBy: "runner",
    status: async () => ({ ...status, version: "1.0.0" }),
    listModels: async () => ({ models: MODELS, selectedOnlyModels: [] }),
    open: async (spec, _options, host) => {
      const providerThreadId = spec.providerThreadId ?? `echo-${spec.threadId}`;
      const path = join(host.threadStorageDir, "echo-state.json");
      const stored = await readFile(path, "utf8").catch(() => "{}");
      const state = stateSchema.safeParse(JSON.parse(stored)).data;
      const resumed = state?.providerThreadId === providerThreadId;
      host.events.identity(providerThreadId);
      if (spec.providerThreadId === null) host.events.started();
      const turns = resumed ? state.turns : 0;
      return new EchoSession(providerThreadId, turns, spec, host);
    },
  };
}
