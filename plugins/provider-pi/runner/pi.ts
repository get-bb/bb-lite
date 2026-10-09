import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { PromptInput, ToolCallResponse } from "@bb/domain";
import {
  RunnerError,
  type ExecutionOptions,
  type ProviderAdapter,
  type ProviderSession,
  type SessionHost,
  type SessionSpec,
  type SteerInput,
  type TurnInput,
} from "@bb/runner";
import { z } from "zod";
import { BB_PI_EXTENSION_SOURCE } from "./bb-extension.js";
import { piDefaultModel, piModels, piThinkingLevel } from "./models.js";
import { PiTranslator } from "./pi-events.js";
import { piPrompt } from "./turn-input.js";
import { piUnsupported, piVersionFrom } from "./version.js";
import { piUiPayload, piUiRequestSchema, piUiResponse } from "./pi-ui.js";
import {
  PiRpc,
  PiRpcError,
  piCommand,
  spawnPi,
  type SpawnPi,
} from "./pi-rpc.js";

const run = promisify(execFile);
export const SESSION_DIR_ENV = "BB_PI_BRIDGE_SESSION_DIR";
const MISSING_CLI =
  "bb could not find the Pi CLI on this machine. Install it with `npm install -g @earendil-works/pi-coding-agent` (https://pi.dev) or set BB_PI_BRIDGE_COMMAND, then retry.";

const READY_TIMEOUT_MS = 30_000;
const LEAF_TIMEOUT_MS = 5_000;
const AUTH_RETRIES = 8;
const AUTH_RETRY_MS = 250;
const VERSION_TTL_MS = 60_000;
const toolCallSchema = z.object({
  kind: z.literal("tool-call"),
  id: z.string(),
  toolCallId: z.string().optional(),
  toolName: z.string(),
  arguments: z.unknown().optional(),
});
const statsSchema = z.object({
  contextUsage: z
    .object({
      tokens: z.number().nullable().optional(),
      contextWindow: z.number(),
    })
    .optional(),
});

export interface PiAdapterOptions {
  spawn?: SpawnPi;
  env?: Record<string, string | undefined>;
  version?: () => Promise<string | null>;
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function launchError(error: unknown) {
  const missing = error instanceof PiRpcError && error.spawnFailed;
  const code = missing ? "missing_executable" : "failed";
  return new RunnerError(code, missing ? MISSING_CLI : describe(error));
}

function prompt(input: PromptInput[], streamingBehavior: string) {
  const { message, images } = piPrompt(input);
  const attached = images.length > 0 ? { images } : {};
  return { type: "prompt", message, ...attached, streamingBehavior };
}

function toolContent({ contentItems }: ToolCallResponse) {
  return contentItems.map((item) => {
    if (item.type === "inputText") return { type: "text", text: item.text };
    const image = /^data:([^;,]+);base64,(.*)$/s.exec(item.imageUrl);
    if (!image) return { type: "text", text: item.imageUrl };
    return { type: "image", mimeType: image[1], data: image[2] };
  });
}

function signature(spec: SessionSpec, options: ExecutionOptions) {
  const tools = JSON.stringify(spec.dynamicTools);
  return `${options.model}|${options.reasoningLevel}|${tools}`;
}

class PiSession implements ProviderSession {
  readonly providerThreadId: string;
  private readonly rpc: PiRpc;
  private readonly translator: PiTranslator;
  private readonly signature: string;
  private readonly scratch: string;
  private readonly toolsFile: string;
  private ready: () => void = () => undefined;
  private delivery = Promise.resolve();
  private lastLeaf: string | null = null;
  private readonly leaves: (string | null)[] = [];
  private leafWaiter: ((leaf: string | null) => void) | null = null;

  constructor(
    spec: SessionSpec,
    options: ExecutionOptions,
    private readonly host: SessionHost,
    adapter: Required<PiAdapterOptions>,
  ) {
    const env = { ...adapter.env, ...host.processEnv };
    const configured = env[SESSION_DIR_ENV]?.trim();
    const sessionDir = configured
      ? resolve(configured)
      : join(homedir(), ".bb", "pi-bridge-sessions");
    this.providerThreadId = spec.providerThreadId ?? spec.threadId;
    const key = this.providerThreadId.replace(/[^A-Za-z0-9._-]/g, "_");
    mkdirSync(sessionDir, { recursive: true });
    this.signature = signature(spec, options);
    this.scratch = join(sessionDir, `${key}.instructions.md`);
    this.toolsFile = join(sessionDir, `${key}.tools.json`);
    const extension = join(sessionDir, "bb-pi-extension.ts");
    writeFileSync(extension, BB_PI_EXTENSION_SOURCE, "utf8");
    writeFileSync(this.toolsFile, JSON.stringify(spec.dynamicTools), "utf8");
    const args = ["--mode", "rpc"];
    args.push("--session", join(sessionDir, `${key}.jsonl`));
    args.push("--session-dir", sessionDir, "--extension", extension);
    if (spec.instructions.trim()) {
      writeFileSync(this.scratch, spec.instructions, "utf8");
      args.push("--append-system-prompt", this.scratch);
    }
    for (const dir of spec.skillDirs) args.push("--skill", dir);
    const slash = options.model.indexOf("/");
    if (slash > 0) {
      args.push("--provider", options.model.slice(0, slash));
      args.push("--model", options.model.slice(slash + 1));
    }
    args.push("--thinking", piThinkingLevel(options.reasoningLevel));
    const presentations = new Map(
      spec.dynamicTools.flatMap((tool) =>
        tool.presentation ? [[tool.name, tool.presentation] as const] : [],
      ),
    );
    this.translator = new PiTranslator(host.events, spec.cwd, presentations);
    const launch = piCommand(env);
    const child = adapter.spawn({
      command: launch.command,
      args: [...launch.args, ...args],
      cwd: spec.cwd,
      env: {
        ...host.processEnv,
        ...spec.env,
        BB_THREAD_ID: spec.threadId,
        PI_BB_TOOLS_FILE: this.toolsFile,
      },
    });
    this.rpc = new PiRpc(child, {
      onEvent: (event) => this.onEvent(event),
      onChannel: (message) => this.onChannel(message),
      onUiRequest: (request) => this.onUiRequest(request),
      onExit: (info) => {
        this.leafWaiter?.(null);
        this.removeScratch();
        host.onExit(info);
      },
    });
  }

  async start() {
    const ready = new Promise<void>((resolve, reject) => {
      this.ready = resolve;
      const message = "Pi did not load the bb extension in time";
      setTimeout(() => reject(new Error(message)), READY_TIMEOUT_MS).unref();
    });
    try {
      await Promise.all([this.rpc.request({ type: "get_state" }), ready]);
    } catch (error) {
      this.rpc.close();
      throw launchError(error);
    }
    this.host.events.identity(this.providerThreadId);
  }

  private onEvent(event: Record<string, unknown>) {
    this.delivery = this.delivery.then(() => this.deliver(event));
  }

  private takeLeaf() {
    const queued = this.leaves.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<string | null>((resolve) => {
      const settle = (leaf: string | null) => {
        clearTimeout(timer);
        this.leafWaiter = null;
        resolve(leaf);
      };
      const timer = setTimeout(() => settle(null), LEAF_TIMEOUT_MS);
      timer.unref();
      this.leafWaiter = settle;
    });
  }

  private async deliver(event: Record<string, unknown>) {
    if (event.type === "agent_end") {
      const leaf = await this.takeLeaf();
      if (leaf !== null) this.lastLeaf = leaf;
      const checkpoint = this.lastLeaf ?? event.providerCheckpointId;
      this.translator.handle({ ...event, providerCheckpointId: checkpoint });
    } else {
      this.translator.handle(event);
    }
    const settled = event.type === "agent_end" && event.willRetry !== true;
    if (settled || event.type === "compaction_end") void this.reportContext();
  }

  private async reportContext() {
    const data = await this.rpc
      .request({ type: "get_session_stats" })
      .catch(() => undefined);
    const usage = statsSchema.safeParse(data ?? {}).data?.contextUsage;
    if (!usage) return;
    this.host.events.contextWindow({
      usedTokens: usage.tokens ?? null,
      modelContextWindow: usage.contextWindow,
      estimated: false,
    });
  }

  private onChannel(message: Record<string, unknown>) {
    if (message.kind === "ready") return this.ready();
    if (message.kind === "agent-end-leaf") {
      const leaf = typeof message.leafId === "string" ? message.leafId : null;
      if (this.leafWaiter) this.leafWaiter(leaf);
      else this.leaves.push(leaf);
      return;
    }
    const call = toolCallSchema.safeParse(message);
    if (!call.success) return;
    this.delivery = this.delivery.then(() => this.callTool(call.data));
  }

  private callTool(call: z.infer<typeof toolCallSchema>) {
    const { id, toolCallId, toolName, arguments: input } = call;
    const { events } = this.host;
    const providerId = toolCallId ?? id;
    const callId = events.bbItemId(providerId) ?? providerId;
    const turnId = this.translator.turnId ?? null;
    const request = { callId, tool: toolName, arguments: input ?? {}, turnId };
    const reply = (content: unknown[], isError: boolean) =>
      this.rpc.sendChannel({ kind: "tool-result", id, content, isError });
    this.host.callTool(request).then(
      (response) => reply(toolContent(response), !response.success),
      (error: unknown) =>
        reply([{ type: "text", text: describe(error) }], true),
    );
  }

  private async onUiRequest(raw: Record<string, unknown>) {
    const request = piUiRequestSchema.safeParse(raw);
    if (!request.success) return undefined;
    const payload = piUiPayload(request.data);
    if (!payload) return { cancelled: true };
    await this.delivery;
    const turnId = this.translator.turnId ?? null;
    const resolution = await this.host.requestInteraction({ payload, turnId });
    return piUiResponse(request.data, resolution);
  }

  private async dispatch(command: Record<string, unknown>) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.rpc.request(command);
      } catch (error) {
        const transient =
          error instanceof PiRpcError &&
          !this.rpc.exited &&
          error.message.startsWith("No API key found for ");
        if (!transient || attempt >= AUTH_RETRIES) throw error;
        await delay(AUTH_RETRY_MS);
      }
    }
  }

  private removeScratch() {
    rmSync(this.scratch, { force: true });
    rmSync(this.toolsFile, { force: true });
  }

  canApply(spec: SessionSpec, options: ExecutionOptions) {
    return !this.rpc.exited && signature(spec, options) === this.signature;
  }

  async startTurn({ clientRequestId, input }: TurnInput) {
    const { events } = this.host;
    events.acceptInput(clientRequestId);
    try {
      await this.dispatch(prompt(input, "followUp"));
    } catch (error) {
      events.error({ message: describe(error) }, { settlesTurn: true });
    }
  }

  async steer({ clientRequestId, input, expectedTurnId }: SteerInput) {
    const turnId = this.translator.turnId;
    if (turnId === undefined || turnId !== expectedTurnId) return "stale";
    await this.dispatch(prompt(input, "steer"));
    this.host.events.acceptInput(clientRequestId);
    return "steered";
  }

  async interrupt() {
    if (this.translator.turnId === undefined) return;
    this.translator.interrupted = true;
    await this.rpc.request({ type: "abort" }).catch(() => undefined);
  }

  async close() {
    this.rpc.close();
    this.removeScratch();
  }
}

async function probeVersion(env: Record<string, string | undefined>) {
  const launch = piCommand(env);
  const args = [...launch.args, "--version"];
  const { stdout } = await run(launch.command, args, { timeout: 15_000 });
  return piVersionFrom(stdout);
}

export function createPiAdapter(
  options: PiAdapterOptions = {},
): ProviderAdapter {
  const env = options.env ?? process.env;
  const adapter = {
    spawn: options.spawn ?? spawnPi,
    env,
    version: options.version ?? (() => probeVersion(env)),
  };
  let probed: { at: number; version: Promise<string | null> } | null = null;
  const version = () => {
    if (probed === null || Date.now() - probed.at > VERSION_TTL_MS) {
      probed = { at: Date.now(), version: adapter.version() };
    }
    return probed.version;
  };
  const gate = async () => {
    const message = piUnsupported(await version().catch(() => null));
    if (message !== null) throw new RunnerError("failed", message);
  };
  return {
    id: "pi",
    approvalEnforcedBy: "provider",
    async status() {
      const base = {
        providerId: "pi",
        executablePath: null,
        auth: "unknown" as const,
      };
      try {
        const found = await version();
        const message = piUnsupported(found);
        return { ...base, installed: true, version: found, message };
      } catch {
        const message = MISSING_CLI;
        return { ...base, installed: false, version: null, message };
      }
    },
    async listModels(cwd) {
      await gate();
      const launch = piCommand(adapter.env);
      const child = adapter.spawn({
        command: launch.command,
        args: [...launch.args, "--mode", "rpc", "--no-session"],
        cwd: cwd ?? homedir(),
        env: Object.fromEntries(
          Object.entries(adapter.env).flatMap(([k, v]) =>
            v === undefined ? [] : [[k, v]],
          ),
        ),
      });
      const rpc = new PiRpc(child, {
        onEvent: () => undefined,
        onExit: () => undefined,
      });
      try {
        const [list, state] = await Promise.all([
          rpc.request({ type: "get_available_models" }),
          rpc.request({ type: "get_state" }).catch(() => undefined),
        ]);
        return piModels(list, piDefaultModel(state));
      } catch (error) {
        throw launchError(error);
      } finally {
        rpc.close();
      }
    },
    async open(spec, execution, host) {
      await gate();
      const session = new PiSession(spec, execution, host, adapter);
      await session.start();
      return session;
    },
  };
}
