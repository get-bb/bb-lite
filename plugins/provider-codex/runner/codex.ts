import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
  isStandaloneBuiltinCompactCommand,
  toProviderExternalThreadName,
  type DynamicTool,
  type PendingInteractionResolution,
} from "@bb/domain";
import { z } from "zod";
import { loginShellEnv } from "@bb/runner";
import {
  RunnerError,
  type ExecutionOptions,
  type ProviderStatus,
  type SessionSpec,
} from "@bb/runner";
import { CodexTranslator, turnSchema } from "./codex-events.js";
import * as codex from "./codex-params.js";
import {
  CodexRpc,
  RpcError,
  spawnAppServer,
  type SpawnAppServer,
} from "./codex-rpc.js";
import type {
  ProviderAdapter,
  ProviderSession,
  SessionHost,
  TurnInput,
} from "@bb/runner";

export interface CodexAdapterOptions {
  spawn?: SpawnAppServer;
  command?: string;
}

const MISSING_CLI =
  "bb could not find the Codex CLI on this machine. Install Codex (https://developers.openai.com/codex/cli) or put `codex` on PATH, then retry.";
const ARCHIVED = /\b(?:session|thread)\s+\S+\s+is archived\b/i;
const ACCOUNT_ERROR = /\b(?:40[13]|429|unauthori[sz]ed|quota|usage limit)\b/i;
const INITIALIZE = {
  clientInfo: { name: "bb", version: "1.0.0", title: null },
  capabilities: { experimentalApi: true },
};
const threadResultSchema = z.object({
  thread: z.object({ id: z.string().min(1) }),
});
const toolCallSchema = z.object({
  turnId: z.string().nullable(),
  callId: z.string().min(1),
  tool: z.string().min(1),
  arguments: z.unknown().optional(),
});

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function launchError(error: unknown) {
  if (error instanceof RunnerError) return error;
  const missing = error instanceof RpcError && error.spawnFailed;
  const code = missing ? "missing_executable" : "failed";
  return new RunnerError(code, missing ? MISSING_CLI : describe(error));
}

class CodexSession implements ProviderSession {
  providerThreadId = "";
  private readonly rpc: CodexRpc;
  private readonly translator: CodexTranslator;
  private readonly signature: string;
  private rebuild = false;

  constructor(
    private readonly spec: SessionSpec,
    options: ExecutionOptions,
    private readonly host: SessionHost,
    adapter: Required<CodexAdapterOptions>,
  ) {
    this.signature = this.signatureOf(spec, options);
    const toEntry = (t: DynamicTool) => [t.name, t.presentation] as const;
    const tools = spec.dynamicTools.map(toEntry);
    const resumed =
      spec.providerThreadId !== null || spec.forkFrom !== undefined;
    const rootThreadId = () => this.providerThreadId || null;
    const onTerminalError = (category: string, detail: string) => {
      const account = category === "unauthorized" || category === "rate-limit";
      const guessed = category === "unknown" && ACCOUNT_ERROR.test(detail);
      if (account || guessed) this.rebuild = true;
    };
    const hooks = { rootThreadId, onTerminalError };
    const injected = new Map(tools);
    const { events } = host;
    const translator = new CodexTranslator(events, injected, hooks, resumed);
    this.translator = translator;
    const env = { ...host.processEnv };
    for (const name of [codex.POOL_URL, codex.POOL_TOKEN]) {
      if (spec.env[name]) env[name] = spec.env[name];
    }
    const args = ["app-server", ...codex.poolArgs(spec.env)];
    const child = adapter.spawn(adapter.command, args, { cwd: spec.cwd, env });
    this.rpc = new CodexRpc(child, {
      onNotification: (method, params) => translator.handle(method, params),
      onRequest: (id, method, params) => this.serve(id, method, params),
      onExit: (info) => host.onExit(info),
    });
  }

  async start(options: ExecutionOptions) {
    const { spec, host, rpc } = this;
    try {
      await rpc.request("initialize", INITIALIZE);
      const extraRoots = spec.skillDirs;
      if (extraRoots.length > 0) {
        await rpc.request("skills/extraRoots/set", { extraRoots });
      }
      const shared = await this.constructionParams(options);
      const resumeId = spec.providerThreadId;
      if (resumeId !== null) host.events.identity(resumeId);
      const fork = resumeId === null ? spec.forkFrom : undefined;
      const construct = () => {
        if (fork !== undefined) {
          const { providerThreadId: threadId, checkpointId } = fork;
          const params = { threadId, lastTurnId: checkpointId, ...shared };
          return rpc.request("thread/fork", params);
        }
        if (resumeId !== null) {
          const params = { threadId: resumeId, excludeTurns: true, ...shared };
          return rpc.request("thread/resume", params);
        }
        return rpc.request("thread/start", { ...shared, ephemeral: false });
      };
      const result = await construct().catch(async (error: unknown) => {
        if (resumeId === null || !ARCHIVED.test(describe(error))) throw error;
        await rpc.request("thread/unarchive", { threadId: resumeId });
        return construct();
      });
      this.providerThreadId = threadResultSchema.parse(result).thread.id;
      if (resumeId === null) host.events.identity(this.providerThreadId);
      return this;
    } catch (error) {
      await rpc.kill();
      throw launchError(error);
    }
  }

  canApply(spec: SessionSpec, options: ExecutionOptions) {
    const unchanged = this.signatureOf(spec, options) === this.signature;
    return unchanged && !this.rebuild && !this.rpc.exited;
  }

  async startTurn({ clientRequestId, input, options }: TurnInput) {
    const { events } = this.host;
    const threadId = this.providerThreadId;
    events.acceptInput(clientRequestId);
    try {
      if (isStandaloneBuiltinCompactCommand(input)) {
        await this.rpc.request("thread/compact/start", { threadId });
        return;
      }
      const { sandbox, ...approval } = codex.permissionSettings(options);
      const sandboxed = sandbox === "workspace-write";
      const roots = sandboxed ? await this.roots(options) : [];
      const result = await this.rpc.request("turn/start", {
        threadId,
        input: codex.toCodexInput(input),
        ...approval,
        sandboxPolicy: codex.sandboxPolicy(options, roots),
        model: options.model || undefined,
        serviceTier: codex.serviceTier(options),
        effort: codex.reasoningEffort(options),
      });
      const { turn } = z.object({ turn: turnSchema }).parse(result);
      this.translator.openTurn(threadId, turn.id);
      const settled = turn.status !== "inProgress";
      if (settled) this.translator.closeTurn(threadId, turn);
    } catch (error) {
      events.retractInput(clientRequestId);
      throw new RunnerError("failed", describe(error));
    }
  }

  async steer(args: TurnInput & { expectedTurnId: string }) {
    const turn = this.host.events.providerTurnId(args.expectedTurnId);
    if (turn === undefined || this.rpc.exited) return "stale";
    const input = codex.toCodexInput(args.input);
    const threadId = this.providerThreadId;
    const params = { threadId, expectedTurnId: turn, input };
    try {
      await this.rpc.request("turn/steer", params);
    } catch (error) {
      if (/no active turn/i.test(describe(error))) return "stale";
      throw new RunnerError("failed", describe(error));
    }
    this.host.events.acceptInput(args.clientRequestId, { turn });
    return "steered";
  }

  async interrupt() {
    const { events } = this.host;
    const active = events.activeTurnId;
    const turnId = active === null ? undefined : events.providerTurnId(active);
    if (turnId === undefined || this.rpc.exited) return;
    const threadId = this.providerThreadId;
    await this.rpc.request("turn/interrupt", { threadId, turnId });
  }

  async close() {
    this.translator.closeAgents();
    await this.rpc.kill();
  }

  async rename(title: string) {
    const name = toProviderExternalThreadName(title);
    const threadId = this.providerThreadId;
    await this.rpc.request("thread/name/set", { threadId, name });
  }

  private signatureOf(spec: SessionSpec, options: ExecutionOptions) {
    const { data } = codex.providerOptionsSchema.safeParse(
      options.providerOptions,
    );
    const token = spec.env[codex.POOL_TOKEN] ?? "";
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const pool = [spec.env[codex.POOL_URL], tokenHash];
    const permissions = codex.permissionSettings(options);
    return JSON.stringify([spec.cwd, data, permissions, pool]);
  }

  private async roots(options: ExecutionOptions) {
    const custom = codex.providerOptionsSchema.parse(options.providerOptions);
    const extra = custom.additionalWorkspaceWriteRoots ?? [];
    const git = await codex.gitWritableRoots(this.spec.cwd);
    return [...new Set([...this.host.writableRoots, ...extra, ...git])];
  }

  private async constructionParams(options: ExecutionOptions) {
    const { spec, host } = this;
    const permissions = codex.permissionSettings(options);
    const sandboxed = permissions.sandbox === "workspace-write";
    const roots = sandboxed ? await this.roots(options) : [];
    const custom = codex.providerOptionsSchema.parse(options.providerOptions);
    const memory = custom.memoryEnabled ?? true;
    const prefix = "shell_environment_policy.set";
    const shellEnv = Object.entries(host.env).map(([name, value]) => [
      `${prefix}.${name}`,
      value,
    ]);
    const soloAgent = {
      "features.multi_agent": false,
      "features.multi_agent_v2.max_concurrent_threads_per_session": 1,
    };
    const writable = { "sandbox_workspace_write.writable_roots": roots };
    const config = {
      [`${prefix}.BB_THREAD_ID`]: spec.threadId,
      ...Object.fromEntries(shellEnv),
      model_reasoning_effort: codex.reasoningEffort(options),
      "features.default_mode_request_user_input": false,
      ...(custom.providerSubagentsEnabled === false ? soloAgent : {}),
      "memories.use_memories": memory,
      "memories.generate_memories": memory,
      ...(roots.length > 0 ? writable : {}),
    };
    const tools = spec.dynamicTools.map((tool) => {
      const { name, description, inputSchema } = tool;
      return { type: "function", name, description, inputSchema };
    });
    const instructions = spec.instructions.trim();
    return {
      ...permissions,
      cwd: spec.cwd,
      ...(instructions ? { developerInstructions: instructions } : {}),
      model: options.model || undefined,
      serviceTier: codex.serviceTier(options),
      config,
      ...(tools.length > 0 ? { dynamicTools: tools } : {}),
    };
  }

  private serve(id: string | number, method: string, params: unknown) {
    const { events } = this.host;
    const fail = (error: unknown) =>
      this.rpc.reject(id, -32000, describe(error));
    const bbTurnId = (turnId: string | null) =>
      turnId === null ? null : (events.bbTurnId(turnId) ?? turnId);
    const call = toolCallSchema.safeParse(params);
    if (method === "item/tool/call" && call.success) {
      const { tool, turnId } = call.data;
      const callId = events.bbItemId(call.data.callId) ?? call.data.callId;
      const input = call.data.arguments ?? {};
      const turn = bbTurnId(turnId);
      const request = { callId, tool, arguments: input, turnId: turn };
      const respond = (result: unknown) => this.rpc.respond(id, result);
      this.host.callTool(request).then(respond, fail);
      return;
    }
    const approval = /^item\/\w+\/requestApproval$/.test(method);
    if (!approval) {
      this.rpc.reject(id, -32601, `Unhandled codex request "${method}"`);
      return;
    }
    try {
      const payload = codex.decodeApproval(method, params);
      if (payload.kind !== "approval") return;
      const { subject } = payload;
      const itemId = events.bbItemId(subject.itemId) ?? subject.itemId;
      const mapped = { ...payload, subject: { ...subject, itemId } };
      const turnId = bbTurnId(codex.approvalSchema.parse(params).turnId);
      const respond = (resolution: PendingInteractionResolution) =>
        this.rpc.respond(id, codex.encodeApproval(method, resolution));
      const request = { payload: mapped, turnId };
      this.host.requestInteraction(request).then(respond, fail);
    } catch (error) {
      this.rpc.reject(id, -32602, describe(error));
    }
  }
}

async function findExecutable(command: string, path: string) {
  for (const dir of isAbsolute(command) ? [""] : path.split(delimiter)) {
    const file = join(dir, command);
    const runnable = access(file, constants.X_OK).then(() => true);
    if (await runnable.catch(() => false)) return file;
  }
  return null;
}

export function createCodexAdapter(
  options: CodexAdapterOptions = {},
): ProviderAdapter {
  const spawn = options.spawn ?? spawnAppServer;
  const adapter = { spawn, command: options.command ?? "codex" };
  const baseEnv = loginShellEnv();
  return {
    id: "codex",
    approvalEnforcedBy: "runner",
    status: async (): Promise<ProviderStatus> => {
      const env = await baseEnv();
      const executablePath = await findExecutable(adapter.command, env.PATH);
      const status = { providerId: "codex" as const, executablePath };
      if (executablePath === null) {
        const missing = { installed: false, auth: "unknown" as const };
        return { ...status, ...missing, version: null, message: MISSING_CLI };
      }
      const run = (args: string[]) =>
        promisify(execFile)(executablePath, args, { env, timeout: 10_000 })
          .then(({ stdout }) => stdout.trim())
          .catch(() => null);
      const version = (await run(["--version"]))?.split(/\s+/).at(-1) ?? null;
      const signedIn = (await run(["login", "status"])) !== null;
      const auth = signedIn ? "ready" : "unauthenticated";
      const message = signedIn ? null : "Run `codex login` to sign in.";
      return { ...status, installed: true, version, auth, message };
    },
    listModels: async (cwd) => {
      const launch = { cwd: cwd ?? homedir(), env: await baseEnv() };
      const child = adapter.spawn(adapter.command, ["app-server"], launch);
      const rpc: CodexRpc = new CodexRpc(child, {
        onNotification: () => undefined,
        onExit: () => undefined,
        onRequest: (id) => rpc.reject(id, -32601, "Unhandled codex request"),
      });
      try {
        await rpc.request("initialize", INITIALIZE);
        const models = codex.parseModels(await rpc.request("model/list", {}));
        return { models, selectedOnlyModels: [] };
      } catch (error) {
        throw launchError(error);
      } finally {
        await rpc.kill();
      }
    },
    open: (spec, execution, host) =>
      new CodexSession(spec, execution, host, adapter).start(execution),
  };
}
