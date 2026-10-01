import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  isStandaloneBuiltinCompactCommand,
  pendingInteractionCommandActionSchema,
  reasoningEffortsForLevels,
  reasoningLevelSchema,
  toProviderExternalThreadName,
  type AvailableModel,
  type PendingInteractionApprovalDecision as Decision,
  type PendingInteractionPayload,
  type PendingInteractionResolution,
  type PromptInput,
  type ThreadEventItemPresentation,
} from "@bb/domain";
import { z } from "zod";
import { loginShellPath, scrubEnv } from "../sessions/agent-env.js";
import {
  RunnerError,
  type ExecutionOptions,
  type ProviderStatus,
  type SessionSpec,
} from "../types.js";
import { CodexTranslator, turnSchema } from "./codex-events.js";
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
} from "./provider.js";

export interface CodexAdapterOptions {
  spawn?: SpawnAppServer;
  command?: string;
}

const MISSING_CLI =
  "bb could not find the Codex CLI on this machine. Install Codex (https://developers.openai.com/codex/cli) or put `codex` on PATH, then retry.";
const POOL_URL = "CODEX_OPENAI_BASE_URL";
const POOL_TOKEN = "CODEX_POOL_AUTH_TOKEN";
const ARCHIVED = /\b(?:session|thread)\s+\S+\s+is archived\b/i;
const ACCOUNT_ERROR = /\b(?:40[13]|429|unauthori[sz]ed|quota|usage limit)\b/i;
const ZERO_WORK_GRACE_MS = 250;
const INITIALIZE = {
  clientInfo: { name: "bb", version: "1.0.0", title: null },
  capabilities: { experimentalApi: true },
};
const DECISIONS: Record<string, Decision> = {
  accept: "allow_once",
  acceptForSession: "allow_for_session",
  decline: "deny",
  cancel: "deny",
};
const ENCODED = {
  allow_once: "accept",
  allow_for_session: "acceptForSession",
  deny: "decline",
} as const;

const text = z.string();
const providerOptionsSchema = z.object({
  memoryEnabled: z.boolean().optional(),
  providerSubagentsEnabled: z.boolean().optional(),
  additionalWorkspaceWriteRoots: z.array(text).optional(),
});
const threadResultSchema = z.object({ thread: z.object({ id: text.min(1) }) });
const fileSystemSchema = z
  .object({ read: z.array(text).nullable(), write: z.array(text).nullable() })
  .transform(({ read, write }) => ({ read: read ?? [], write: write ?? [] }));
const permissionsSchema = z.object({
  network: z.object({ enabled: z.boolean().nullable() }).nullish(),
  fileSystem: fileSystemSchema.nullish(),
});
const approvalSchema = z.object({
  turnId: text,
  itemId: text,
  reason: text.nullish(),
  command: text.nullish(),
  cwd: text.nullish(),
  commandActions: z.array(z.unknown()).nullish(),
  additionalPermissions: permissionsSchema.nullish(),
  availableDecisions: z.array(z.unknown()).nullish(),
  grantRoot: text.nullish(),
  permissions: permissionsSchema.optional(),
});
const toolCallSchema = z.object({
  turnId: text.nullable(),
  callId: text.min(1),
  tool: text.min(1),
  arguments: z.unknown().optional(),
});
const modelSchema = z.looseObject({ id: text.min(1), model: text.min(1) });

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function poolArgs(env: Record<string, string>) {
  const url = env[POOL_URL];
  if (!url || !env[POOL_TOKEN]) return [];
  const provider = "model_providers.bb-account-pool";
  const overrides = [
    `openai_base_url=${JSON.stringify(url)}`,
    'model_provider="bb-account-pool"',
    `${provider}.name="OpenAI"`,
    `${provider}.base_url=${JSON.stringify(url)}`,
    `${provider}.wire_api="responses"`,
    `${provider}.requires_openai_auth=true`,
    `${provider}.supports_websockets=false`,
    `${provider}.env_http_headers.x-bb-account-pool-token="${POOL_TOKEN}"`,
  ];
  return overrides.flatMap((override) => ["-c", override]);
}

function permissionSettings(options: ExecutionOptions) {
  if (options.permissionMode === "full") {
    const sandbox = "danger-full-access";
    return { approvalPolicy: "never", approvalsReviewer: "user", sandbox };
  }
  const automatic = options.permissionMode === "auto";
  const unattended = options.permissionEscalation === "deny" && !automatic;
  const approvalPolicy = unattended ? "never" : "on-request";
  const approvalsReviewer = automatic ? "auto_review" : "user";
  return { approvalPolicy, approvalsReviewer, sandbox: "workspace-write" };
}

function reasoningEffort(options: ExecutionOptions) {
  const level = options.reasoningLevel;
  if (level !== "none" && level !== "ultracode") return level;
  const message = `Codex does not support the ${level} reasoning level.`;
  throw new RunnerError("failed", message);
}

function toCodexInput(input: PromptInput[]) {
  return input.map((chunk) => {
    if (chunk.type === "image") return { type: chunk.type, url: chunk.url };
    if (chunk.type === "localImage")
      return { type: chunk.type, path: chunk.path };
    const attached = `[Attached file: ${chunk.type === "localFile" ? chunk.path : ""}]`;
    const body = chunk.type === "text" ? chunk.text : attached;
    return { type: "text", text: body, text_elements: [] };
  });
}

async function gitWritableRoots(cwd: string): Promise<string[]> {
  try {
    const workspace = await realpath(cwd);
    const gitFile = join(workspace, ".git");
    const read = async (path: string) => (await readFile(path, "utf8")).trim();
    const pointer = /^gitdir:\s*(.+)$/m.exec(await read(gitFile))?.[1]?.trim();
    if (!pointer) return [];
    const gitDir = await realpath(resolve(workspace, pointer));
    const backlink = resolve(gitDir, await read(join(gitDir, "gitdir")));
    const common = await realpath(
      resolve(gitDir, await read(join(gitDir, "commondir"))),
    );
    const linked = gitDir.startsWith(join(common, "worktrees") + sep);
    if (backlink !== gitFile || !linked) return [];
    const head = await read(join(gitDir, "HEAD"));
    const ref = /^ref:\s*(refs\/[\w./-]+)$/.exec(head)?.[1];
    const refDir = ref && !ref.includes("..") ? dirname(ref) : "refs/heads";
    const candidates = ["objects", refDir, join("logs", refDir)];
    const resolved = await Promise.all(
      candidates.map((path) => realpath(join(common, path)).catch(() => null)),
    );
    const inside = (path: string | null): path is string =>
      path !== null && path.startsWith(common + sep);
    return [gitDir, ...resolved.filter(inside)];
  } catch {
    return [];
  }
}

function decodeApproval(
  method: string,
  params: unknown,
): PendingInteractionPayload {
  const request = approvalSchema.parse(params);
  const { itemId } = request;
  const reason = request.reason ?? null;
  const all: Decision[] = ["allow_once", "allow_for_session", "deny"];
  const grantable = (
    grant: z.infer<typeof permissionsSchema> | null | undefined,
  ) => {
    const network = grant?.network ?? null;
    const fileSystem = grant?.fileSystem ?? null;
    const files = fileSystem
      ? fileSystem.read.length + fileSystem.write.length
      : 0;
    const usable = network?.enabled === true || files > 0;
    return { profile: { network, fileSystem }, usable };
  };
  const offer = (decisions: Decision[], usable: boolean) => {
    const offered = decisions.filter(
      (d) => usable || d !== "allow_for_session",
    );
    if (offered.length > 0) return offered;
    throw new Error("Approval request did not include usable decisions");
  };
  if (method === "item/permissions/requestApproval") {
    const permissions = grantable(request.permissions).profile;
    const subject = {
      kind: "permission_grant" as const,
      itemId,
      toolName: null,
    };
    const availableDecisions = all;
    return {
      kind: "approval",
      subject: { ...subject, permissions },
      reason,
      availableDecisions,
    };
  }
  if (method === "item/fileChange/requestApproval") {
    const writeScope = request.grantRoot || null;
    const fileSystem = { read: [], write: writeScope ? [writeScope] : [] };
    const sessionGrant = writeScope ? { network: null, fileSystem } : null;
    const subject = {
      kind: "file_change" as const,
      itemId,
      writeScope,
      sessionGrant,
    };
    const availableDecisions = offer(all, writeScope !== null);
    return { kind: "approval", subject, reason, availableDecisions };
  }
  if (!request.command)
    throw new Error("Command approval request has no command");
  const grant = grantable(request.additionalPermissions);
  const named = (request.availableDecisions ?? Object.keys(ENCODED)).flatMap(
    (decision) => (typeof decision === "string" ? [DECISIONS[decision]] : []),
  );
  const decisions = [...new Set(request.availableDecisions ? named : all)];
  const actions = (request.commandActions ?? []).flatMap((action) => {
    const parsed = pendingInteractionCommandActionSchema.safeParse(action);
    return parsed.success ? [parsed.data] : [];
  });
  const { command } = request;
  const cwd = request.cwd ?? null;
  const sessionGrant = grant.usable ? grant.profile : null;
  const subject = { kind: "command" as const, itemId, command, cwd, actions };
  const availableDecisions = offer(decisions.filter(Boolean), grant.usable);
  return {
    kind: "approval",
    subject: { ...subject, sessionGrant },
    reason,
    availableDecisions,
  };
}

function encodeApproval(
  method: string,
  resolution: PendingInteractionResolution,
) {
  const decision = "decision" in resolution ? resolution.decision : "deny";
  if (method !== "item/permissions/requestApproval") {
    return { decision: ENCODED[decision] };
  }
  const granted =
    "grantedPermissions" in resolution ? resolution.grantedPermissions : null;
  if (decision === "deny" || granted === null) {
    return { permissions: {}, scope: "turn" };
  }
  const list = (paths: string[]) => (paths.length > 0 ? paths : null);
  const { network, fileSystem: files } = granted;
  const fileSystem = files && {
    read: list(files.read),
    write: list(files.write),
  };
  const permissions = {
    ...(network ? { network: { enabled: network.enabled } } : {}),
    ...(fileSystem ? { fileSystem } : {}),
  };
  const scope = decision === "allow_for_session" ? "session" : "turn";
  return { permissions, scope };
}

function parseModels(result: unknown): AvailableModel[] {
  const data = z.object({ data: z.array(z.unknown()) }).parse(result).data;
  const fallback = reasoningEffortsForLevels([
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  return data.flatMap((entry) => {
    const parsed = modelSchema.safeParse(entry);
    if (!parsed.success) return [];
    const raw = parsed.data;
    const listed = Array.isArray(raw.supportedReasoningEfforts)
      ? raw.supportedReasoningEfforts
      : [];
    const levels = listed.flatMap((effort: unknown) => {
      const level = z.object({ reasoningEffort: reasoningLevelSchema });
      const known = level.safeParse(effort);
      return known.success ? [known.data.reasoningEffort] : [];
    });
    const efforts = reasoningEffortsForLevels([...new Set(levels)]);
    const supported = efforts.length > 0 ? efforts : fallback;
    const preferred = reasoningLevelSchema.safeParse(
      raw.defaultReasoningEffort,
    );
    const usable =
      preferred.success &&
      supported.some((effort) => effort.reasoningEffort === preferred.data);
    return [
      {
        id: raw.id,
        model: raw.model,
        displayName:
          typeof raw.displayName === "string" ? raw.displayName : raw.model,
        description: typeof raw.description === "string" ? raw.description : "",
        supportedReasoningEfforts: supported,
        defaultReasoningEffort: usable
          ? preferred.data
          : supported[0].reasoningEffort,
        isDefault: raw.isDefault === true,
      },
    ];
  });
}

let zeroWorkTurns = 0;

class CodexSession implements ProviderSession {
  providerThreadId = "";
  private readonly rpc: CodexRpc;
  private readonly translator: CodexTranslator;
  private readonly signature: string;
  private rootTurnsOpened = 0;
  private awaitingCompaction = false;
  private rebuild = false;

  constructor(
    private readonly spec: SessionSpec,
    options: ExecutionOptions,
    private readonly host: SessionHost,
    adapter: Required<CodexAdapterOptions>,
  ) {
    this.signature = this.signatureOf(spec, options);
    const tools = spec.dynamicTools.map(
      (tool): [string, ThreadEventItemPresentation | undefined] => [
        tool.name,
        tool.presentation,
      ],
    );
    const resumed = spec.providerThreadId !== null || spec.fork !== null;
    this.translator = new CodexTranslator(
      host.events,
      new Map(tools),
      {
        rootThreadId: () => this.providerThreadId || null,
        onRootTurnOpened: () => {
          this.rootTurnsOpened += 1;
          this.awaitingCompaction = false;
        },
        onThreadStatus: (status) => {
          const failed = status === "systemError";
          if (!this.awaitingCompaction || (status !== "idle" && !failed))
            return;
          this.awaitingCompaction = false;
          const error =
            "codex reported a system error before the compaction turn started";
          this.settleZeroWork(this.rootTurnsOpened, failed ? error : undefined);
        },
        onTerminalError: (category, detail) => {
          const account =
            category === "unauthorized" || category === "rate-limit";
          const guessed = category === "unknown" && ACCOUNT_ERROR.test(detail);
          if (account || guessed) this.rebuild = true;
        },
      },
      resumed,
    );
    const env = { ...host.processEnv };
    for (const name of [POOL_URL, POOL_TOKEN]) {
      if (spec.env[name]) env[name] = spec.env[name];
    }
    const args = ["app-server", ...poolArgs(spec.env)];
    const child = adapter.spawn(adapter.command, args, { cwd: spec.cwd, env });
    this.rpc = new CodexRpc(child, {
      onNotification: (method, params) =>
        this.translator.handle(method, params),
      onRequest: (id, method, params) => this.serve(id, method, params),
      onExit: (info) => host.onExit(info),
    });
  }

  async start(options: ExecutionOptions) {
    const { spec, host, rpc } = this;
    try {
      await rpc.request("initialize", INITIALIZE);
      if (spec.skillDirs.length > 0) {
        await rpc.request("skills/extraRoots/set", {
          extraRoots: spec.skillDirs,
        });
      }
      const roots = await this.writableRoots(options);
      const custom = providerOptionsSchema.parse(options.providerOptions);
      const memory = custom.memoryEnabled ?? true;
      const shellEnv = Object.entries(host.env).map(([name, value]) => [
        `shell_environment_policy.set.${name}`,
        value,
      ]);
      const config = {
        "shell_environment_policy.set.BB_THREAD_ID": spec.threadId,
        ...Object.fromEntries(shellEnv),
        model_reasoning_effort: reasoningEffort(options),
        "features.default_mode_request_user_input": false,
        ...(custom.providerSubagentsEnabled === false
          ? {
              "features.multi_agent": false,
              "features.multi_agent_v2.max_concurrent_threads_per_session": 1,
            }
          : {}),
        "memories.use_memories": memory,
        "memories.generate_memories": memory,
        ...(roots.length > 0 && options.permissionMode !== "full"
          ? { "sandbox_workspace_write.writable_roots": roots }
          : {}),
      };
      const tools = spec.dynamicTools.map(
        ({ name, description, inputSchema }) => ({
          type: "function",
          name,
          description,
          inputSchema,
        }),
      );
      const instructions = spec.instructions.trim();
      const shared = {
        ...permissionSettings(options),
        cwd: spec.cwd,
        ...(instructions ? { developerInstructions: instructions } : {}),
        model: options.model || undefined,
        serviceTier: options.serviceTier === "fast" ? "fast" : null,
        config,
        ...(tools.length > 0 ? { dynamicTools: tools } : {}),
      };
      const resumeId = spec.providerThreadId;
      if (resumeId !== null) host.events.identity(resumeId);
      const construct = () => {
        if (resumeId !== null) {
          const params = { threadId: resumeId, excludeTurns: true, ...shared };
          return rpc.request("thread/resume", params);
        }
        if (spec.fork === null) {
          return rpc.request("thread/start", { ...shared, ephemeral: false });
        }
        const { sourceProviderThreadId: threadId, checkpointId } = spec.fork;
        const lastTurnId = checkpointId ?? undefined;
        return rpc.request("thread/fork", { threadId, lastTurnId, ...shared });
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
      if (error instanceof RunnerError) throw error;
      const missing = error instanceof RpcError && error.spawnFailed;
      const code = missing ? "missing_executable" : "failed";
      throw new RunnerError(code, missing ? MISSING_CLI : describe(error));
    }
  }

  canApply(spec: SessionSpec, options: ExecutionOptions) {
    const unchanged = this.signatureOf(spec, options) === this.signature;
    return unchanged && !this.rebuild && !this.rpc.exited;
  }

  async startTurn({ clientRequestId, input, options }: TurnInput) {
    const { events } = this.host;
    const threadId = this.providerThreadId;
    const opened = this.rootTurnsOpened;
    events.acceptInput(clientRequestId);
    try {
      if (isStandaloneBuiltinCompactCommand(input)) {
        this.awaitingCompaction = true;
        await this.rpc.request("thread/compact/start", { threadId });
        return;
      }
      const { sandbox, ...approval } = permissionSettings(options);
      const writableRoots = await this.writableRoots(options);
      const workspace = {
        type: "workspaceWrite",
        writableRoots,
        networkAccess: true,
      };
      const tmp = { excludeTmpdirEnvVar: false, excludeSlashTmp: false };
      const sandboxPolicy =
        sandbox === "workspace-write"
          ? { ...workspace, ...tmp }
          : { type: "dangerFullAccess" };
      const result = await this.rpc.request("turn/start", {
        threadId,
        input: toCodexInput(input),
        ...approval,
        sandboxPolicy,
        model: options.model || undefined,
        serviceTier: options.serviceTier === "fast" ? "fast" : null,
        effort: reasoningEffort(options),
      });
      const parsed = z.object({ turn: turnSchema }).safeParse(result);
      if (!parsed.success) {
        const settle = () => this.settleZeroWork(opened);
        setTimeout(settle, ZERO_WORK_GRACE_MS).unref();
        return;
      }
      const { turn } = parsed.data;
      this.translator.openTurn(threadId, turn.id);
      if (turn.status !== "inProgress")
        this.translator.closeTurn(threadId, turn);
    } catch (error) {
      this.awaitingCompaction = false;
      events.retractInput(clientRequestId);
      throw new RunnerError("failed", describe(error));
    }
  }

  async steer({
    clientRequestId,
    input,
    expectedTurnId,
  }: TurnInput & { expectedTurnId: string }) {
    const turn = this.host.events.providerTurnId(expectedTurnId);
    if (turn === undefined || this.rpc.exited) return "stale";
    const threadId = this.providerThreadId;
    const params = {
      threadId,
      expectedTurnId: turn,
      input: toCodexInput(input),
    };
    try {
      await this.rpc.request("turn/steer", params);
    } catch (error) {
      if (/no active turn/i.test(describe(error))) return "stale";
      throw new RunnerError("failed", describe(error));
    }
    this.host.events.acceptInput(clientRequestId, { turn });
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
    this.translator.closeAgents("failed");
    await this.rpc.kill();
  }

  async rename(title: string) {
    const name = toProviderExternalThreadName(title);
    const threadId = this.providerThreadId;
    await this.rpc.request("thread/name/set", { threadId, name });
  }

  private signatureOf(spec: SessionSpec, options: ExecutionOptions) {
    const custom = providerOptionsSchema.safeParse(
      options.providerOptions,
    ).data;
    const token = spec.env[POOL_TOKEN] ?? "";
    const pool = [
      spec.env[POOL_URL],
      createHash("sha256").update(token).digest("hex"),
    ];
    const permissions = permissionSettings(options);
    return JSON.stringify([spec.cwd, custom, permissions, pool]);
  }

  private async writableRoots(options: ExecutionOptions) {
    if (options.permissionMode === "full") return [];
    const custom = providerOptionsSchema.parse(options.providerOptions);
    const extra = custom.additionalWorkspaceWriteRoots ?? [];
    const git = await gitWritableRoots(this.spec.cwd);
    return [...new Set([...this.host.writableRoots, ...extra, ...git])];
  }

  private settleZeroWork(openedBefore: number, error?: string) {
    const { events } = this.host;
    const stale = this.rootTurnsOpened !== openedBefore || events.activeTurnId;
    if (stale || this.rpc.exited) return;
    zeroWorkTurns += 1;
    const turn = `zero-work-${zeroWorkTurns}`;
    events.openTurn({ turn });
    events.closeTurn({ turn, status: error ? "failed" : "completed", error });
  }

  private serve(id: string | number, method: string, params: unknown) {
    const { events } = this.host;
    const fail = (error: unknown) =>
      this.rpc.reject(id, -32000, describe(error));
    const bbTurnId = (turnId: string | null) =>
      turnId === null ? null : (events.bbTurnId(turnId) ?? turnId);
    if (method === "item/tool/call") {
      const call = toolCallSchema.safeParse(params);
      if (!call.success) {
        this.rpc.reject(id, -32602, `Invalid codex tool call params`);
        return;
      }
      const { callId, tool, turnId } = call.data;
      const request = {
        callId: events.bbItemId(callId) ?? callId,
        tool,
        arguments: call.data.arguments ?? {},
        turnId: bbTurnId(turnId),
      };
      const respond = (result: unknown) => this.rpc.respond(id, result);
      this.host.callTool(request).then(respond, fail);
      return;
    }
    const approvals = ["commandExecution", "fileChange", "permissions"];
    if (!approvals.some((kind) => method === `item/${kind}/requestApproval`)) {
      this.rpc.reject(id, -32601, `Unhandled codex request "${method}"`);
      return;
    }
    try {
      const payload = decodeApproval(method, params);
      if (payload.kind !== "approval") return;
      const { subject } = payload;
      const itemId = events.bbItemId(subject.itemId) ?? subject.itemId;
      const mapped = { ...payload, subject: { ...subject, itemId } };
      const turnId = bbTurnId(approvalSchema.parse(params).turnId);
      const respond = (resolution: PendingInteractionResolution) =>
        this.rpc.respond(id, encodeApproval(method, resolution));
      this.host
        .requestInteraction({ payload: mapped, turnId })
        .then(respond, fail);
    } catch (error) {
      this.rpc.reject(id, -32602, describe(error));
    }
  }
}

async function findExecutable(command: string, path: string | undefined) {
  const dirs = isAbsolute(command) ? [""] : (path ?? "").split(delimiter);
  for (const dir of dirs) {
    const candidate = join(dir, command);
    const found = await access(candidate, constants.X_OK).then(
      () => true,
      () => false,
    );
    if (found) return candidate;
  }
  return null;
}

export function createCodexAdapter(
  options: CodexAdapterOptions = {},
): ProviderAdapter {
  const adapter = {
    spawn: options.spawn ?? spawnAppServer,
    command: options.command ?? "codex",
  };
  const baseEnv = async () => {
    const env = scrubEnv(process.env);
    return { ...env, PATH: (await loginShellPath()) ?? env.PATH ?? "" };
  };
  const run = promisify(execFile);
  return {
    id: "codex",
    approvalEnforcedBy: "runner",
    status: async (): Promise<ProviderStatus> => {
      const env = await baseEnv();
      const executablePath = await findExecutable(adapter.command, env.PATH);
      const status = { providerId: "codex" as const, executablePath };
      if (executablePath === null) {
        const missing = {
          installed: false,
          version: null,
          auth: "unknown" as const,
        };
        return { ...status, ...missing, message: MISSING_CLI };
      }
      const exec = (args: string[]) =>
        run(executablePath, args, { env, timeout: 10_000 }).then(
          ({ stdout }) => stdout.trim(),
          () => null,
        );
      const version = (await exec(["--version"]))?.split(/\s+/).at(-1) ?? null;
      const login = await exec(["login", "status"]);
      const auth = login === null ? "unauthenticated" : "ready";
      const message = login === null ? "Run `codex login` to sign in." : null;
      return { ...status, installed: true, version, auth, message };
    },
    listModels: async (cwd) => {
      const env = await baseEnv();
      const child = adapter.spawn(adapter.command, ["app-server"], {
        cwd: cwd ?? homedir(),
        env,
      });
      const idle = { onNotification() {}, onExit() {} };
      const rpc: CodexRpc = new CodexRpc(child, {
        ...idle,
        onRequest: (id, method) =>
          rpc.reject(id, -32601, `Unhandled "${method}"`),
      });
      try {
        await rpc.request("initialize", INITIALIZE);
        const models = parseModels(await rpc.request("model/list", {}));
        return { models, selectedOnlyModels: [] };
      } catch (error) {
        const missing = error instanceof RpcError && error.spawnFailed;
        const code = missing ? "missing_executable" : "failed";
        throw new RunnerError(code, missing ? MISSING_CLI : describe(error));
      } finally {
        await rpc.kill();
      }
    },
    open: (spec, execution, host) =>
      new CodexSession(spec, execution, host, adapter).start(execution),
  };
}
