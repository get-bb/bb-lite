import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { promisify } from "node:util";
import {
  forkSession,
  query,
  type HookCallback,
  type Options,
  type PermissionMode,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { loginShellPath, scrubEnv } from "../sessions/agent-env.js";
import {
  RunnerError,
  type ExecutionOptions,
  type ProviderModels,
  type ProviderStatus,
  type SessionSpec,
} from "../types.js";
import { ClaudePermissions } from "./claude-interactions.js";
import {
  bbToolServer,
  buildModels,
  buildQueryOptions,
  claudeSettings,
  contextSnapshot,
  promptText,
  resolveExecutable,
  type ClaudeSettings,
} from "./claude-options.js";
import { BB_MCP_SERVER } from "./claude-tools.js";
import { ClaudeTranslator } from "./claude-translate.js";
import type {
  ProviderAdapter,
  ProviderSession,
  SessionHost,
  SteerInput,
  TurnInput,
} from "./provider.js";

type QueryControls =
  | "interrupt"
  | "setPermissionMode"
  | "setModel"
  | "applyFlagSettings"
  | "getContextUsage"
  | "initializationResult"
  | "close";
export type ClaudeQuery = AsyncIterable<unknown> & Pick<Query, QueryControls>;
export type ClaudeQueryInput = AsyncIterable<SDKUserMessage>;
export interface ClaudeAdapterOptions {
  query?: (args: {
    prompt: string | ClaudeQueryInput;
    options: Options;
  }) => ClaudeQuery;
  forkSession?: (
    sessionId: string,
    options: { upToMessageId?: string },
  ) => Promise<{ sessionId: string }>;
}

const MISSING_CLI =
  "bb could not find the Claude Code CLI on this machine. Install Claude Code (https://claude.com/claude-code), or set BB_CLAUDE_CODE_EXECUTABLE to the full path of the claude binary, then restart bb.";
const MISSING_BINARY = /Native CLI binary for .+ not found/;
const STOPPED = "Thread stopped while awaiting permission approval";
const CLOSE_TIMEOUT_MS = 4_000;
const CONTEXT_TIMEOUT_MS = 5_000;
const MODELS_TTL_MS = 120_000;
const STDERR_TAIL = 4_000;
const SUBAGENTS_OFF =
  "bb has disabled Claude Code native subagents; use bb delegation instead.";
const WORKFLOWS_OFF = "bb has disabled the Claude Code Workflow tool.";
const DISABLED_TOOLS: Record<string, "subagents" | "workflows" | undefined> = {
  Agent: "subagents",
  Task: "subagents",
  Workflow: "workflows",
};
const headerSchema = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  error: z.string().optional(),
});
const authSchema = z.object({ loggedIn: z.boolean() });
const outputSchema = z.object({ stdout: z.string() });

function describe(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return MISSING_BINARY.test(message) ? MISSING_CLI : message;
}

function launchError(error: unknown) {
  if (error instanceof RunnerError) return error;
  const message = describe(error);
  const code = message === MISSING_CLI ? "missing_executable" : "failed";
  return new RunnerError(code, message);
}

function signedIn(report: string) {
  try {
    return authSchema.safeParse(JSON.parse(report)).data?.loggedIn;
  } catch {
    return undefined;
  }
}

function timeout(ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const elapsed = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref();
  });
  return { elapsed, cancel: () => clearTimeout(timer) };
}

class InputQueue implements ClaudeQueryInput {
  private readonly messages: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(message: SDKUserMessage) {
    this.messages.push(message);
    this.wake?.();
  }

  end() {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      const next = this.messages.shift();
      if (next !== undefined) yield next;
      else if (this.ended) return;
      else await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

class ClaudeSession implements ProviderSession {
  providerThreadId = "";
  private readonly input = new InputQueue();
  private readonly abort = new AbortController();
  private readonly translator: ClaudeTranslator;
  private readonly permissions: ClaudePermissions;
  private readonly signature: string;
  private query: ClaudeQuery | null = null;
  private done: Promise<void> = Promise.resolve();
  private interrupting: Promise<unknown> | null = null;
  private settings: ClaudeSettings;
  private mode: PermissionMode;
  private ended = false;
  private closing = false;
  private rebuild = false;
  private stderr = "";
  private contextRevision = 0;
  private toolCalls = 0;

  constructor(
    private readonly spec: SessionSpec,
    private options: ExecutionOptions,
    private readonly host: SessionHost,
    private readonly adapter: Required<ClaudeAdapterOptions>,
  ) {
    const { events } = host;
    this.settings = claudeSettings(options);
    this.signature = this.signatureOf(spec, options);
    this.mode = options.planMode ? "plan" : this.settings.baseMode;
    this.translator = new ClaudeTranslator(events, {
      threadId: spec.threadId,
      cwd: spec.cwd,
      sandboxed: this.settings.baseMode !== "bypassPermissions",
      injected: new Map(spec.dynamicTools.map((t) => [t.name, t.presentation])),
    });
    if (options.model) this.translator.setModel(options.model);
    this.permissions = new ClaudePermissions({
      requestInteraction: (request) => host.requestInteraction(request),
      itemId: (toolUseId) => events.bbItemId(toolUseId) ?? toolUseId,
      turnId: () => events.activeTurnId,
      mode: () => this.mode,
      escalation: () => this.options.permissionEscalation,
      planApproved: () => this.leavePlanMode(),
    });
  }

  async start() {
    const { spec, host, adapter } = this;
    try {
      const { fork } = spec;
      const upToMessageId = fork?.checkpointId ?? undefined;
      const source = fork?.sourceProviderThreadId;
      const forked =
        spec.providerThreadId === null && source !== undefined
          ? await adapter.forkSession(source, { upToMessageId })
          : null;
      const resume = spec.providerThreadId ?? forked?.sessionId;
      const sessionId = resume ?? randomUUID();
      const tools = spec.dynamicTools;
      const names = tools.map((tool) => `mcp__${BB_MCP_SERVER}__${tool.name}`);
      const server = bbToolServer(tools, (tool, input, toolUseId) => {
        this.toolCalls += 1;
        const known = toolUseId && host.events.bbItemId(toolUseId);
        const callId = known || toolUseId || `call-${this.toolCalls}`;
        const turnId = host.events.activeTurnId;
        return host.callTool({ callId, tool, arguments: input, turnId });
      });
      const servers = { mcpServers: { [BB_MCP_SERVER]: server } };
      const root = process.getuid?.() === 0;
      const bypass = this.mode === "bypassPermissions";
      const options: Options = {
        ...(await buildQueryOptions(spec, this.settings, host)),
        abortController: this.abort,
        permissionMode: root && bypass ? "default" : this.mode,
        canUseTool: this.permissions.canUseTool,
        hooks: { PreToolUse: [{ hooks: [this.denyDisabledTools] }] },
        stderr: (chunk) => {
          this.stderr = `${this.stderr}${chunk}`.slice(-STDERR_TAIL);
        },
        ...(tools.length > 0 ? { ...servers, allowedTools: names } : {}),
        ...(resume === undefined ? { sessionId } : { resume }),
      };
      const stream = adapter.query({ prompt: this.input, options });
      this.query = stream;
      this.providerThreadId = sessionId;
      host.events.identity(sessionId);
      const usage = { usedTokens: null, modelContextWindow: null };
      const unknown = { contextWindowUsage: { ...usage, estimated: true } };
      host.events.contextWindow(unknown);
      this.done = this.consume(stream);
      return this;
    } catch (error) {
      throw launchError(error);
    }
  }

  canApply(spec: SessionSpec, options: ExecutionOptions) {
    const unchanged = this.signatureOf(spec, options) === this.signature;
    return unchanged && !this.rebuild && !this.ended && !this.closing;
  }

  async startTurn(turn: TurnInput) {
    await this.submit(turn);
  }

  async steer(turn: SteerInput) {
    const active = this.host.events.activeTurnId === turn.expectedTurnId;
    if (!active || this.ended || this.closing) return "stale";
    await this.submit(turn);
    return "steered";
  }

  async interrupt() {
    if (this.closing || this.ended) return;
    this.host.events.settle("interrupted");
    this.stop();
    this.interrupting = this.query?.interrupt().catch(() => undefined) ?? null;
    await this.interrupting;
  }

  async close() {
    this.stop();
    const stream = this.query;
    if (stream === null || this.ended) return;
    const interrupted =
      this.interrupting ?? stream.interrupt().catch(() => undefined);
    const drained = interrupted.then(() => {
      this.input.end();
      return this.done;
    });
    const limit = timeout(CLOSE_TIMEOUT_MS);
    await Promise.race([drained, limit.elapsed]);
    limit.cancel();
    if (this.ended) return;
    this.abort.abort();
    stream.close();
  }

  private stop() {
    this.closing = true;
    this.translator.stopTasks();
    this.permissions.cancelPending(STOPPED);
  }

  private signatureOf(spec: SessionSpec, options: ExecutionOptions) {
    const settings = claudeSettings(options);
    const tools = spec.dynamicTools.map((tool) => [
      tool.name,
      tool.description,
      tool.inputSchema,
    ]);
    const construction = [spec.cwd, spec.instructions, tools, spec.skillDirs];
    const { baseMode, disable1MContext, chrome, writableRoots } = settings;
    const fixed = [baseMode, disable1MContext, chrome, writableRoots];
    return JSON.stringify([...construction, ...fixed]);
  }

  private readonly denyDisabledTools: HookCallback = async (input) => {
    const tool = input.hook_event_name === "PreToolUse" ? input.tool_name : "";
    const setting = DISABLED_TOOLS[tool];
    if (setting === undefined || this.settings[setting]) {
      return { continue: true };
    }
    const hookSpecificOutput = {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason:
        setting === "subagents" ? SUBAGENTS_OFF : WORKFLOWS_OFF,
    };
    return { continue: true, hookSpecificOutput };
  };

  private leavePlanMode() {
    const { baseMode } = this.settings;
    if (this.mode === baseMode) return;
    this.mode = baseMode;
    void this.query?.setPermissionMode(baseMode).catch(() => undefined);
  }

  private async applySettings(options: ExecutionOptions) {
    const next = claudeSettings(options);
    const { model, flags } = this.settings;
    if (next.model !== model) {
      await this.query?.setModel(next.model || undefined);
      if (next.model) this.translator.setModel(next.model);
    }
    if (JSON.stringify(next.flags) !== JSON.stringify(flags)) {
      await this.query?.applyFlagSettings(next.flags);
    }
    this.settings = next;
    if (!options.planMode || this.mode === "plan") return;
    await this.query?.setPermissionMode("plan");
    this.mode = "plan";
  }

  private async submit({ clientRequestId, input, options }: TurnInput) {
    const content = promptText(input, options.planMode);
    if (content === undefined) throw new RunnerError("failed", "Missing input");
    if (this.ended || this.closing) {
      throw new RunnerError("failed", "Claude SDK input stream is closed");
    }
    await this.applySettings(options).catch((error: unknown) => {
      throw new RunnerError("failed", describe(error));
    });
    this.options = options;
    this.contextRevision += 1;
    this.input.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: this.providerThreadId,
      uuid: randomUUID(),
    });
    const { events } = this.host;
    this.translator.acceptInput();
    events.acceptInput(clientRequestId);
    if (events.activeTurnId === null) events.openTurn();
  }

  private async consume(stream: ClaudeQuery) {
    let failure: unknown;
    try {
      for await (const message of stream) this.receive(message);
    } catch (error) {
      failure = error;
    }
    this.ended = true;
    this.input.end();
    if (this.closing) return;
    this.permissions.cancelPending("Claude Code ended its session");
    const ended = "Claude Code ended its session";
    const message = failure === undefined ? ended : describe(failure);
    this.host.onExit({ message, stderrTail: this.stderr.trim() });
  }

  private receive(message: unknown) {
    const header = headerSchema.safeParse(message).data;
    if (this.closing || header === undefined) return;
    const { type, subtype, error } = header;
    const spoken = ["assistant", "user", "stream_event"].includes(type);
    if (spoken) this.contextRevision += 1;
    const sessionId = header.session_id?.trim();
    if (sessionId && sessionId !== this.providerThreadId) {
      this.providerThreadId = sessionId;
      this.host.events.identity(sessionId);
    }
    const unauthorized =
      error === "authentication_failed" || error === "oauth_org_not_allowed";
    if (type === "assistant" && unauthorized) this.rebuild = true;
    this.translator.handle(message);
    const compacted = type === "system" && subtype === "compact_boundary";
    if (type === "result" || compacted) void this.captureContext();
  }

  private async captureContext() {
    const stream = this.query;
    if (stream === null) return;
    this.contextRevision += 1;
    const revision = this.contextRevision;
    const limit = timeout(CONTEXT_TIMEOUT_MS);
    const read = stream.getContextUsage().catch(() => null);
    const report = await Promise.race([read, limit.elapsed]);
    limit.cancel();
    const stale = revision !== this.contextRevision || this.closing;
    const snapshot = contextSnapshot(report, this.providerThreadId);
    if (stale || this.ended || snapshot === undefined) return;
    const usage = {
      usedTokens: snapshot.usedTokens,
      modelContextWindow: snapshot.contextWindowTokens,
      estimated: snapshot.estimated,
    };
    const update = { contextWindowUsage: { ...usage, snapshot } };
    this.host.events.contextWindow(update);
  }
}

export function createClaudeAdapter(
  options: ClaudeAdapterOptions = {},
): ProviderAdapter {
  const adapter = { query, forkSession, ...options };
  const baseEnv = async () => {
    const env = scrubEnv(process.env);
    return { ...env, PATH: (await loginShellPath()) ?? env.PATH ?? "" };
  };
  let models: {
    cwd: string;
    at: number;
    list: Promise<ProviderModels>;
  } | null = null;
  const probeModels = async (cwd: string) => {
    const env = await baseEnv();
    const pathToClaudeCodeExecutable = await resolveExecutable(env);
    const probe = { cwd, env, maxTurns: 0, persistSession: false };
    const sources = ["user" as const, "project" as const, "local" as const];
    const settings = { settingSources: sources, pathToClaudeCodeExecutable };
    const session = adapter.query({
      prompt: ".",
      options: { ...probe, ...settings },
    });
    try {
      const { models: discovered } = await session.initializationResult();
      if (discovered.length > 0) return buildModels(discovered);
      throw new Error("Claude Code reported no models.");
    } finally {
      session.close();
    }
  };
  return {
    id: "claude-code",
    approvalEnforcedBy: "provider",
    status: async (): Promise<ProviderStatus> => {
      const env = await baseEnv();
      const found = await resolveExecutable(env).catch(() => undefined);
      const executablePath = found ?? null;
      const status = { providerId: "claude-code" as const, executablePath };
      if (executablePath === null) {
        const missing = { installed: false, auth: "unknown" as const };
        return { ...status, ...missing, version: null, message: MISSING_CLI };
      }
      const run = (args: string[]) =>
        promisify(execFile)(executablePath, args, { env, timeout: 10_000 })
          .catch((error: unknown) => outputSchema.safeParse(error).data)
          .then((output) => output?.stdout.trim() ?? "");
      const version = (await run(["--version"])).split(/\s+/)[0] || null;
      const login = signedIn(await run(["auth", "status", "--json"]));
      const state = login ? "ready" : "unauthenticated";
      const auth = login === undefined ? "unknown" : state;
      const message = login === false ? "Run `claude` to sign in." : null;
      return { ...status, installed: true, version, auth, message };
    },
    listModels: (cwd) => {
      const dir = cwd ?? homedir();
      const fresh =
        models?.cwd === dir && Date.now() - models.at < MODELS_TTL_MS;
      if (models !== null && fresh) return models.list;
      const list = probeModels(dir).catch((error: unknown) => {
        models = null;
        throw launchError(error);
      });
      models = { cwd: dir, at: Date.now(), list };
      return list;
    },
    open: (spec, execution, host) =>
      new ClaudeSession(spec, execution, host, adapter).start(),
  };
}
