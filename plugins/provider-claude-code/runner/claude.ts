import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { TransformStream } from "node:stream/web";
import { promisify } from "node:util";
import {
  query,
  type HookCallback,
  type Options,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { loginShellEnv } from "@bb/runner";
import {
  RunnerError,
  type ExecutionOptions,
  type ProviderStatus,
  type SessionSpec,
} from "@bb/runner";
import { ClaudePermissions } from "./claude-interactions.js";
import * as claude from "./claude-options.js";
import { BB_MCP_SERVER, decodeJson } from "./claude-tools.js";
import { ClaudeTranslator } from "./claude-translate.js";
import type {
  ProviderAdapter,
  ProviderSession,
  SessionHost,
  SteerInput,
  TurnInput,
} from "@bb/runner";

type Controls =
  | "interrupt"
  | "setModel"
  | "applyFlagSettings"
  | "initializationResult"
  | "close";
export type ClaudeQuery = AsyncIterable<unknown> & Pick<Query, Controls>;
export type ClaudeQueryInput = AsyncIterable<SDKUserMessage>;
type QueryArgs = { prompt: string | ClaudeQueryInput; options: Options };
export interface ClaudeAdapterOptions {
  query?: (args: QueryArgs) => ClaudeQuery;
}

const MISSING_CLI =
  "bb could not find the Claude Code CLI on this machine. Install Claude Code (https://claude.com/claude-code), or set BB_CLAUDE_CODE_EXECUTABLE to the full path of the claude binary, then restart bb.";
const MISSING_BINARY = /Native CLI binary for .+ not found/;
const STOPPED = "Thread stopped while awaiting permission approval";
const ENDED = "Claude Code ended its session";
const CLOSED = "Claude SDK input stream is closed";
const SUBAGENTS_OFF =
  "bb has disabled Claude Code native subagents; use bb delegation instead.";
const WORKFLOWS_OFF = "bb has disabled the Claude Code Workflow tool.";
const UNAUTHORIZED = ["authentication_failed", "oauth_org_not_allowed"];
const CLOSE_TIMEOUT_MS = 4_000;
const headerSchema = z.object({
  type: z.string(),
  session_id: z.string().optional(),
  error: z.string().optional(),
});
const reportSchema = z.object({ stdout: z.string() });
const authSchema = z.object({ loggedIn: z.boolean() });

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

class ClaudeSession implements ProviderSession {
  providerThreadId = "";
  private readonly input = new TransformStream<SDKUserMessage>();
  private readonly prompts = this.input.writable.getWriter();
  private readonly abort = new AbortController();
  private readonly translator: ClaudeTranslator;
  private readonly permissions: ClaudePermissions;
  private readonly signature: string;
  private query: ClaudeQuery | null = null;
  private done: Promise<void> = Promise.resolve();
  private interrupting: Promise<unknown> | null = null;
  private settings: claude.ClaudeSettings;
  private ended = false;
  private closing = false;
  private rebuild = false;
  private stderr = "";
  private toolCalls = 0;

  constructor(
    private readonly spec: SessionSpec,
    private options: ExecutionOptions,
    private readonly host: SessionHost,
    private readonly adapter: Required<ClaudeAdapterOptions>,
  ) {
    const { events } = host;
    this.settings = claude.claudeSettings(options, spec.customModels);
    this.signature = this.signatureOf(spec, options);
    const sandboxed = this.settings.baseMode !== "bypassPermissions";
    const labelled = spec.dynamicTools.map(
      (tool) => [tool.name, tool.presentation] as const,
    );
    const context = { sandboxed, injected: new Map(labelled) };
    this.translator = new ClaudeTranslator(events, context);
    if (options.model) this.translator.setModel(options.model);
    this.permissions = new ClaudePermissions({
      requestInteraction: (request) => host.requestInteraction(request),
      itemId: (toolUseId) => events.bbItemId(toolUseId) ?? toolUseId,
      turnId: () => events.activeTurnId,
      mode: () => this.settings.baseMode,
      escalation: () => this.options.permissionEscalation,
    });
  }

  async start() {
    const { spec, host, adapter } = this;
    const { events } = host;
    try {
      const resume = spec.providerThreadId ?? undefined;
      const sessionId = resume ?? randomUUID();
      const tools = spec.dynamicTools;
      const names = tools.map((tool) => `mcp__${BB_MCP_SERVER}__${tool.name}`);
      const server = claude.bbToolServer(tools, (tool, input, toolUseId) => {
        this.toolCalls += 1;
        const known = toolUseId && events.bbItemId(toolUseId);
        const callId = known || toolUseId || `call-${this.toolCalls}`;
        const turnId = events.activeTurnId;
        return host.callTool({ callId, tool, arguments: input, turnId });
      });
      const servers = { mcpServers: { [BB_MCP_SERVER]: server } };
      const options: Options = {
        ...(await claude.buildQueryOptions(spec, this.settings, host)),
        abortController: this.abort,
        permissionMode: claude.startMode(this.settings.baseMode),
        canUseTool: this.permissions.canUseTool,
        hooks: { PreToolUse: [{ hooks: [this.denyDisabledTools] }] },
        stderr: (chunk) => {
          this.stderr = `${this.stderr}${chunk}`.slice(-4_000);
        },
        ...(tools.length > 0 ? { ...servers, allowedTools: names } : {}),
        ...(resume === undefined ? { sessionId } : { resume }),
      };
      const prompt = this.input.readable;
      const stream = adapter.query({ prompt, options });
      this.query = stream;
      this.providerThreadId = sessionId;
      events.identity(sessionId);
      const unknown = { usedTokens: null, modelContextWindow: null };
      events.contextWindow({ ...unknown, estimated: true });
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
      void this.prompts.close().catch(() => undefined);
      return this.done;
    });
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
    });
    await Promise.race([drained, expired]);
    clearTimeout(timer);
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
    const { cwd, instructions, dynamicTools, skillDirs } = spec;
    const { fixed } = claude.claudeSettings(options, spec.customModels);
    return JSON.stringify([cwd, instructions, dynamicTools, skillDirs, fixed]);
  }

  private readonly denyDisabledTools: HookCallback = async (input) => {
    const tool = input.hook_event_name === "PreToolUse" ? input.tool_name : "";
    const { subagents, workflows } = this.settings;
    const agent = tool === "Agent" || tool === "Task";
    const blocked = agent ? !subagents : tool === "Workflow" && !workflows;
    if (!blocked) return { continue: true };
    const hookSpecificOutput = {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: agent ? SUBAGENTS_OFF : WORKFLOWS_OFF,
    };
    return { continue: true, hookSpecificOutput };
  };

  private async applySettings(options: ExecutionOptions) {
    const next = claude.claudeSettings(options, this.spec.customModels);
    const { model, flags } = this.settings;
    if (next.model !== model) {
      await this.query?.setModel(next.model || undefined);
      if (next.model) this.translator.setModel(next.model);
    }
    if (JSON.stringify(next.flags) !== JSON.stringify(flags)) {
      await this.query?.applyFlagSettings(next.flags);
    }
    this.settings = next;
  }

  private async submit({ clientRequestId, input, options }: TurnInput) {
    const content = claude.promptText(input);
    if (content === undefined) throw new RunnerError("failed", "Missing input");
    if (this.ended || this.closing) throw new RunnerError("failed", CLOSED);
    await this.applySettings(options).catch((error: unknown) => {
      throw new RunnerError("failed", describe(error));
    });
    this.options = options;
    const prompt = { role: "user" as const, content };
    const session = { session_id: this.providerThreadId, uuid: randomUUID() };
    const message = { type: "user" as const, message: prompt, ...session };
    await this.prompts.write({ ...message, parent_tool_use_id: null });
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
    if (this.closing) return;
    this.permissions.cancelPending(ENDED);
    const message = failure === undefined ? ENDED : describe(failure);
    this.host.onExit({ message, stderrTail: this.stderr.trim() });
  }

  private receive(message: unknown) {
    const header = headerSchema.safeParse(message).data;
    if (this.closing || header === undefined) return;
    const sessionId = header.session_id?.trim();
    if (sessionId && sessionId !== this.providerThreadId) {
      this.providerThreadId = sessionId;
      this.host.events.identity(sessionId);
    }
    const denied = UNAUTHORIZED.includes(header.error ?? "");
    if (header.type === "assistant" && denied) this.rebuild = true;
    this.translator.handle(message);
  }
}

export function createClaudeAdapter(
  options: ClaudeAdapterOptions = {},
): ProviderAdapter {
  const adapter = { query, ...options };
  const baseEnv = loginShellEnv();
  return {
    id: "claude-code",
    approvalEnforcedBy: "provider",
    status: async (): Promise<ProviderStatus> => {
      const env = await baseEnv();
      const found = await claude.resolveExecutable(env).catch(() => undefined);
      const executablePath = found ?? null;
      const status = { providerId: "claude-code" as const, executablePath };
      if (executablePath === null) {
        const missing = { installed: false, auth: "unknown" as const };
        return { ...status, ...missing, version: null, message: MISSING_CLI };
      }
      const run = (args: string[]) =>
        promisify(execFile)(executablePath, args, { env, timeout: 10_000 })
          .catch((error: unknown) => reportSchema.safeParse(error).data)
          .then((output) => output?.stdout.trim() ?? "");
      const version = (await run(["--version"])).split(/\s+/)[0] || null;
      const report = decodeJson(await run(["auth", "status", "--json"]));
      const login = authSchema.safeParse(report).data?.loggedIn;
      const state = login ? "ready" : "unauthenticated";
      const auth = login === undefined ? "unknown" : state;
      const message = login === false ? "Run `claude` to sign in." : null;
      return { ...status, installed: true, version, auth, message };
    },
    listModels: async (cwd) => {
      const sources = ["user" as const, "project" as const, "local" as const];
      try {
        const env = await baseEnv();
        const executable = await claude.resolveExecutable(env);
        const session = adapter.query({
          prompt: ".",
          options: {
            cwd: cwd ?? homedir(),
            env,
            maxTurns: 0,
            persistSession: false,
            settingSources: sources,
            pathToClaudeCodeExecutable: executable,
          },
        });
        const ready = session.initializationResult();
        const { models } = await ready.finally(() => session.close());
        if (models.length > 0) return claude.buildModels(models);
        throw new Error("Claude Code reported no models.");
      } catch (error) {
        throw launchError(error);
      }
    },
    open: (spec, execution, host) =>
      new ClaudeSession(spec, execution, host, adapter).start(),
  };
}
