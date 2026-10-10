import {
  isStandaloneBuiltinCompactCommand,
  pendingInteractionResolutionSchema,
  reasoningEffortsForLevels,
  THREAD_PROVIDER_COMMANDS_STATE_KIND,
  THREAD_SESSION_OPTIONS_STATE_KIND,
  userQuestionPendingInteractionResolutionSchema,
} from "@bb/domain";
import type {
  AvailableModel,
  DynamicTool,
  ExtensionKind,
  JsonValue,
  PendingInteractionPayload,
  PendingInteractionResolution,
  PermissionMode,
  PromptInput,
  ReasoningLevel,
  ServiceTier,
  SessionOptionSelections,
  ThreadSessionOption,
  ToolCallResponse,
} from "@bb/domain";
import { RunnerError, debug, type EventBuilder } from "@bb/runner";
import { randomBytes } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, basename, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  acpLaunchSpecSchema,
  type AcpLaunchSpec,
  type AcpNativeReasoning as AcpBridgeNativeReasoning,
  type AcpPermissionCli as AcpBridgePermissionCli,
  type AcpReasoningCli as AcpBridgeReasoningCli,
} from "../src/launch-spec.js";

import {
  createAcpTranslator,
  type AcpCompactionOutcome,
  type AcpTranslator,
} from "./acp-translator.js";
import {
  compactionOutcomeForEndTurn,
  grokContextUsageFromPromptResult,
  grokContextWindowSizeFromSessionModels,
  resolveAcpDialect,
  type AcpDialect,
} from "./dialect.js";
import type { AcpMaintenanceDialect } from "./bridge/provider-maintenance.js";
import { describeAcpSignIn } from "./auth-guidance.js";
import { planAcpElicitation } from "./elicitation.js";
import {
  buildAcpPermissionInteractionPayload,
  resolveAcpPermissionDecision,
} from "./interactions.js";
import { agentProcessEnv, execPortableFile } from "./process.js";
import { mimeTypeFromExtension } from "./values.js";
import {
  buildAcpModelListParams,
  buildAcpModelSelectionParams,
  buildAcpSessionParams,
  type AcpAgentCommandParam,
  type AcpSessionParams,
  type AcpSkillRoot,
  ACP_DEFAULT_MODEL_ID,
} from "./session-params.js";
import { buildCursorParameterizedModelCatalog } from "./cursor-model-selection.js";
import {
  getAcpProviderStatus,
  getAcpProviderUsage,
  type AcpStatusTarget,
} from "./bridge/provider-maintenance.js";
import {
  type AcpConfigOption,
  acpConfigStateResultSchema,
  acpPromptResultSchema,
  acpReadTextFileParamsSchema,
  acpRequestPermissionParamsSchema,
  acpSessionForkResultSchema,
  acpSessionNewResultSchema,
  acpSessionNotificationParamsSchema,
  acpAgentMessageChunkUpdateSchema,
  extractAcpContentText,
  acpSessionUpdateSchema,
  acpUsageUpdateSchema,
  type AcpConfigStateResult,
  type AcpSessionModels,
  type AcpUsageUpdate,
  acpStopReasonSchema,
  acpWriteTextFileParamsSchema,
  type AcpContentBlock,
  type AcpPermissionOption,
} from "./wire.js";
import {
  ACP_CORE_CLIENT_REQUEST_METHODS,
  AcpAgentResponseError,
  createAcpAgentConnection,
  requestAcpInitialize,
  type AcpAgentConnection,
  type AcpAgentRequestResponder,
} from "./bridge/agent-connection.js";
import type { AcpAgentCapabilities } from "./client/capabilities.js";
import {
  createAcpSessionModel,
  type AcpSessionModel,
} from "./session/session-model.js";
import { isJsonObject } from "./session/decode.js";
import {
  isUserSelectableSessionOption,
  toThreadProviderCommandsState,
  toThreadSessionOptionsState,
} from "./session/thread-state.js";
import type { AcpSessionEvent } from "./session/session-types.js";
import {
  approveCursorSessionMcpServer,
  revokeCursorSessionMcpServer,
  type CursorMcpApproval,
} from "./bridge/cursor-mcp-approval.js";
import {
  ACP_NATIVE_REASONING_EFFORTS,
  buildAgentModelCatalog,
  buildAcpNativeReasoningSupport,
  buildModelCatalogFromConfigOptions,
  buildModelCatalogFromSessionModels,
  acpNativeReasoningLevelToValue,
  findAcpModelConfigOption,
  findAcpThoughtLevelConfigOption,
  parseAgentModelLines,
  splitPrimaryModels,
  type AcpNativeReasoningSupport,
  type AgentModelCatalog,
} from "./bridge/model-catalog.js";
import {
  decodeToolCallResponsePayload,
  type BridgeToolCallContent,
  type BridgeToolCallImage,
  ACP_BRIDGE_MCP_SERVER_NAME,
  buildAcpMcpServerConfig,
  dynamicToolBridgeRequestSchema,
  ensureMcpProxyScript,
  type AcpMcpServerConfig,
} from "./bridge/tool-proxy-mcp.js";

export interface AcpExecutionOptions {
  model?: string | undefined;
  reasoningLevel?: ReasoningLevel | undefined;
  serviceTier?: ServiceTier | undefined;
  permissionMode: PermissionMode;
  envVars?: Record<string, string> | undefined;
  sessionOptions?: SessionOptionSelections | undefined;
  providerOptions?: Record<string, unknown> | undefined;
}

export interface AcpSessionOutput {
  readonly events: EventBuilder;
  identity(providerThreadId: string): void;
  failed(message: string): void;
  replaced(providerThreadId: string): void;
  callTool(
    call: { callId: string; tool: string; arguments: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<ToolCallResponse>;
  requestInteraction(
    payload: PendingInteractionPayload,
  ): Promise<PendingInteractionResolution>;
}

type BridgeExecutionOptions = AcpExecutionOptions;

interface TurnInputSettlement {
  resolve(): void;
  reject(error: Error): void;
}

const outputsByBbThreadId = new Map<string, AcpSessionOutput>();
let mcpScriptDirectory: string | null = null;

function log(text: string): void {
  debug(text.trimEnd());
}

interface AcpSessionPolicy {
  permissionMode: "accept-edits" | "full";
  workspaceWriteRoots: string[];
}

interface PendingAcpPermission {
  responder: AcpAgentRequestResponder;
  options: AcpPermissionOption[];
}

interface AcpPendingTurnInput {
  clientRequestId: string;
  input: PromptInput[];
  settlement: TurnInputSettlement | null;
  options: BridgeExecutionOptions;
}

interface AcpNativeConfigState {
  configOptions: readonly AcpConfigOption[] | undefined;
  models: AcpSessionModels | undefined;
}

interface AcpThreadSession {
  bbThreadId: string;
  construction: AcpSessionParams;
  nativeConfig: AcpNativeConfigState;
  providerThreadId: string;
  cwd: string;
  dialect: AcpDialect;
  translator: AcpTranslator;
  connection: AcpAgentConnection;
  model: AcpSessionModel;
  promptWorkOpen: boolean;
  agentTurnQuietTimer: ReturnType<typeof setTimeout> | undefined;
  agentUpdateCount: number;
  publishedThreadState: Map<string, string>;
  capabilities: AcpAgentCapabilities | undefined;
  supportsImageInput: boolean;
  supportsLoadSession: boolean;
  policy: AcpSessionPolicy;
  pendingInstructions: string | undefined;
  activePromptKind: "turn" | "compaction" | "agent" | null;
  compactionAgentMessage: string;
  queuedInputs: AcpPendingTurnInput[];
  promptRequestPending: boolean;
  cancelRequested: boolean;
  restartAfterCancelError: boolean;
  loading: boolean;
  loadingSessionId: string | undefined;
  pendingLoadUsageUpdate: AcpUsageUpdate | undefined;
  grokContextWindowSize: number | undefined;
  stopping: boolean;
  turnSettled: Promise<void> | undefined;
  pendingPermissions: Set<PendingAcpPermission>;
  pendingElicitations: Set<AcpAgentRequestResponder>;
  pendingToolCalls: Set<AbortController>;
  cursorMcpApproval: CursorMcpApproval | undefined;
  deferStartEmit: AcpDeferredStartEmitter | undefined;
  awaitingFirstPrompt: boolean;
  turnOutputCount: number;
}

type AcpDeferredStartEmitter = (
  emit: (session: AcpThreadSession) => void,
  sessionId?: string,
) => void;

const sessionsByBbThreadId = new Map<string, AcpThreadSession>();
const bbThreadIdByProviderThreadId = new Map<string, string>();
let dynamicToolBridgePromise: Promise<AcpDynamicToolBridge> | null = null;

const THREAD_STOP_CANCEL_TIMEOUT_MS = 4_000;
const AGENT_TURN_QUIET_MS = 5_000;
const SESSION_BUSY_QUIET_MS = 2_000;
const SESSION_BUSY_MAX_WAITS = 300;
const SESSION_BUSY_MAX_RETRIES = 3;
const ACP_SESSION_BUSY_ERROR_CODE = -32003;
const ACP_SESSION_SETUP_TIMEOUT_MS = 300_000;
const ACP_SESSION_CONFIG_TIMEOUT_MS = 60_000;
const ACP_AUTHENTICATE_TIMEOUT_MS = 120_000;

function sessionEvents(threadId: string): EventBuilder | undefined {
  return outputsByBbThreadId.get(threadId)?.events;
}

function rememberGrokContextWindow(
  session: AcpThreadSession,
  models: unknown,
): void {
  if (session.dialect.id !== "grok") {
    return;
  }
  const size = grokContextWindowSizeFromSessionModels(models);
  if (size !== undefined) {
    session.grokContextWindowSize = size;
  }
}

function emitGrokContextWindow(session: AcpThreadSession, used: number): void {
  if (
    session.dialect.id !== "grok" ||
    session.grokContextWindowSize === undefined
  ) {
    return;
  }
  const cost = session.model.snapshot().usage?.cost ?? undefined;
  sessionEvents(session.bbThreadId)?.contextWindow(
    {
      usedTokens: used,
      modelContextWindow: session.grokContextWindowSize,
      estimated: false,
      ...(cost === undefined ? {} : { cost }),
    },
    undefined,
    true,
  );
}

function emitSessionError(session: AcpThreadSession, message: string): void {
  for (const controller of session.pendingToolCalls) controller.abort();
  if (session.activePromptKind !== null) {
    session.translator.failed(message);
  }
  outputsByBbThreadId.get(session.bbThreadId)?.failed(message);
}

async function resolveBridgeProcessArgsForMcpServer(): Promise<string[]> {
  if (mcpScriptDirectory === null) {
    throw new Error("The ACP adapter has no directory for its tool proxy");
  }
  return [await ensureMcpProxyScript(mcpScriptDirectory)];
}

function resolveBridgeProcessEnvForMcpServer(): AcpMcpServerConfig["env"] {
  const electronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  if (electronRunAsNode === undefined) {
    return [];
  }

  return [{ name: "ELECTRON_RUN_AS_NODE", value: electronRunAsNode }];
}

async function forwardDynamicToolCall(
  args: {
    arguments: Record<string, unknown>;
    callId: string;
    threadId: string;
    tool: string;
  },
  signal: AbortSignal,
): Promise<
  | {
      ok: true;
      content: string;
      contentBlocks: BridgeToolCallContent[];
      images: BridgeToolCallImage[];
      isError?: boolean;
    }
  | { ok: false; error: string }
> {
  const session = sessionsByBbThreadId.get(args.threadId);
  if (
    !session ||
    !session.providerThreadId ||
    session.stopping ||
    session.connection.exited
  ) {
    return { ok: false, error: "No active ACP session for dynamic tool call." };
  }

  const controller = new AbortController();
  session.pendingToolCalls.add(controller);
  session.translator.noteInjectedToolCall(session.bbThreadId, args.tool);
  try {
    const output = outputsByBbThreadId.get(session.bbThreadId);
    if (!output) {
      return {
        ok: false,
        error: "No active ACP session for dynamic tool call.",
      };
    }
    const result = await output.callTool(
      { callId: args.callId, tool: args.tool, arguments: args.arguments },
      AbortSignal.any([signal, controller.signal]),
    );
    return { ok: true, ...decodeToolCallResponsePayload(result) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    session.pendingToolCalls.delete(controller);
  }
}

function handleDynamicToolBridgeSocket(
  bridge: AcpDynamicToolBridge,
  socket: Socket,
): void {
  const controller = new AbortController();
  socket.once("close", () => controller.abort());
  let handled = false;
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    if (handled) return;
    buffer += chunk;
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex === -1) {
      return;
    }
    handled = true;
    const line = buffer.slice(0, newlineIndex);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      socket.end(`${JSON.stringify({ ok: false, error: "Invalid JSON" })}\n`);
      return;
    }
    const request = dynamicToolBridgeRequestSchema.safeParse(parsed);
    if (!request.success || request.data.token !== bridge.token) {
      socket.end(
        `${JSON.stringify({ ok: false, error: "Invalid dynamic tool request" })}\n`,
      );
      return;
    }
    if (request.data.kind === "initialized") {
      log(
        `acp bridge: "${ACP_BRIDGE_MCP_SERVER_NAME}" answered initialize for thread "${request.data.threadId}" (${request.data.toolCount} tools)\n`,
      );
      socket.end(`${JSON.stringify({ ok: true, content: "" })}\n`);
      return;
    }
    void forwardDynamicToolCall(request.data, controller.signal).then(
      (response) => {
        if (controller.signal.aborted) return;
        socket.end(`${JSON.stringify(response)}\n`);
      },
    );
  });
}

async function ensureDynamicToolBridge(): Promise<AcpDynamicToolBridge> {
  if (dynamicToolBridgePromise) {
    return dynamicToolBridgePromise;
  }

  dynamicToolBridgePromise = new Promise((resolveBridge, rejectBridge) => {
    const host = "127.0.0.1";
    const server = createServer((socket) => {
      socket.on("error", () => {});
      void dynamicToolBridgePromise?.then((bridge) => {
        handleDynamicToolBridgeSocket(bridge, socket);
      });
    });
    server.once("error", rejectBridge);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectBridge(
          new Error("ACP dynamic tool bridge did not bind a TCP port"),
        );
        return;
      }
      resolveBridge({
        host,
        port: address.port,
        server,
        token: randomBytes(32).toString("hex"),
      });
    });
  });

  return dynamicToolBridgePromise;
}

async function buildSessionMcpServers(
  params: AcpSessionParams,
): Promise<AcpMcpServerConfig[]> {
  const dynamicTools = params.dynamicTools ?? [];
  if (dynamicTools.length === 0) {
    return [];
  }
  const bridge = await ensureDynamicToolBridge();
  const config = buildAcpMcpServerConfig({
    bridgeArgs: await resolveBridgeProcessArgsForMcpServer(),
    command: process.execPath,
    dynamicTools,
    host: bridge.host,
    port: bridge.port,
    runtimeEnv: resolveBridgeProcessEnvForMcpServer(),
    threadId: params.threadId,
    token: bridge.token,
  });
  log(
    `acp bridge: built "${config.name}" session MCP config for thread "${params.threadId}" (${dynamicTools.length} tools)\n`,
  );
  return [config];
}

const ACP_DEFAULT_MODEL: AvailableModel = {
  id: ACP_DEFAULT_MODEL_ID,
  model: ACP_DEFAULT_MODEL_ID,
  displayName: "Agent default",
  description: "Model selection is managed by the connected ACP agent.",
  supportedReasoningEfforts: ACP_NATIVE_REASONING_EFFORTS,
  defaultReasoningEffort: "medium",
  isDefault: true,
};

const MODEL_LIST_TIMEOUT_MS = 30_000;
const ACP_NATIVE_REASONING_DISCOVERY_TIMEOUT_MS = 5_000;
const AUTH_REQUIRED_MODEL_LIST_ERROR_MESSAGE =
  "ACP agent is not authenticated.";

function reasoningSupportFromCli(
  reasoningCli:
    | Pick<AcpBridgeReasoningCli, "supportedLevels" | "defaultLevel">
    | undefined,
):
  | Pick<AvailableModel, "supportedReasoningEfforts" | "defaultReasoningEffort">
  | undefined {
  if (reasoningCli === undefined) {
    return undefined;
  }
  const supportedLevels = reasoningCli.supportedLevels;
  const defaultReasoningEffort =
    reasoningCli.defaultLevel !== undefined &&
    supportedLevels.includes(reasoningCli.defaultLevel)
      ? reasoningCli.defaultLevel
      : supportedLevels.includes("medium")
        ? "medium"
        : supportedLevels[0];
  return {
    supportedReasoningEfforts: reasoningEffortsForLevels(supportedLevels),
    defaultReasoningEffort,
  };
}

function applyReasoningCliToModel(
  model: AvailableModel,
  reasoningCli: AcpBridgeReasoningCli | undefined,
): AvailableModel {
  const reasoningSupport = reasoningSupportFromCli(reasoningCli);
  return reasoningSupport === undefined
    ? model
    : {
        ...model,
        ...reasoningSupport,
      };
}

function modelHasOnlyAgentManagedReasoning(model: AvailableModel): boolean {
  return (
    model.supportedReasoningEfforts.length === 1 &&
    model.supportedReasoningEfforts[0]?.reasoningEffort === "medium" &&
    model.defaultReasoningEffort === "medium"
  );
}

function applyNativeReasoningHintToModel(
  model: AvailableModel,
  nativeReasoning: AcpBridgeNativeReasoning | undefined,
): AvailableModel {
  const reasoningSupport = reasoningSupportFromCli(nativeReasoning);
  return reasoningSupport === undefined ||
    !modelHasOnlyAgentManagedReasoning(model)
    ? model
    : {
        ...model,
        ...reasoningSupport,
      };
}

function applyConfiguredReasoningToModel(
  model: AvailableModel,
  args: {
    reasoningCli: AcpBridgeReasoningCli | undefined;
    nativeReasoning: AcpBridgeNativeReasoning | undefined;
  },
): AvailableModel {
  return args.reasoningCli !== undefined
    ? applyReasoningCliToModel(model, args.reasoningCli)
    : applyNativeReasoningHintToModel(model, args.nativeReasoning);
}

function applyConfiguredReasoningToModels(
  models: readonly AvailableModel[],
  args: {
    reasoningCli: AcpBridgeReasoningCli | undefined;
    nativeReasoning: AcpBridgeNativeReasoning | undefined;
  },
): AvailableModel[] {
  return models.map((model) => applyConfiguredReasoningToModel(model, args));
}

function resolveHintReasoningValue(args: {
  hint: Pick<AcpBridgeReasoningCli, "supportedLevels" | "levelValues">;
  reasoningLevel: ReasoningLevel;
}): string | undefined {
  const override = args.hint.levelValues?.[args.reasoningLevel];
  if (override !== undefined) {
    return override;
  }
  return args.hint.supportedLevels.includes(args.reasoningLevel)
    ? args.reasoningLevel
    : undefined;
}

function nativeReasoningToThoughtLevelOption(
  nativeReasoning: AcpBridgeNativeReasoning | undefined,
): AcpConfigOption | undefined {
  if (nativeReasoning === undefined) {
    return undefined;
  }
  const options = nativeReasoning.supportedLevels.flatMap((level) => {
    const value = resolveHintReasoningValue({
      hint: nativeReasoning,
      reasoningLevel: level,
    });
    return value === undefined
      ? []
      : [
          {
            value,
            name: value,
          },
        ];
  });
  const currentValue =
    nativeReasoning.defaultLevel === undefined
      ? undefined
      : resolveHintReasoningValue({
          hint: nativeReasoning,
          reasoningLevel: nativeReasoning.defaultLevel,
        });
  return {
    id: nativeReasoning.configId,
    category: "thought_level",
    type: "select",
    ...(currentValue !== undefined ? { currentValue } : {}),
    options,
  };
}

function permissionCliArgsForMode(
  permissionCli: AcpBridgePermissionCli | undefined,
  permissionMode: AcpSessionPolicy["permissionMode"],
): string[] {
  if (permissionCli === undefined) {
    return [];
  }
  switch (permissionMode) {
    case "full":
      return permissionCli.full ?? [];
    case "accept-edits":
      return permissionCli.workspaceWrite ?? [];
  }
}

function applyPermissionCliArgs(
  agentArgs: readonly string[],
  permissionCli: AcpBridgePermissionCli | undefined,
  permissionMode: AcpSessionPolicy["permissionMode"],
): string[] {
  const permissionArgs = permissionCliArgsForMode(
    permissionCli,
    permissionMode,
  );
  if (permissionArgs.length === 0) {
    return [...agentArgs];
  }
  const insertAfterArgs = Math.min(
    permissionCli?.insertAfterArgs ?? 0,
    agentArgs.length,
  );
  return [
    ...agentArgs.slice(0, insertAfterArgs),
    ...permissionArgs,
    ...agentArgs.slice(insertAfterArgs),
  ];
}

interface AcpDynamicToolBridge {
  host: string;
  port: number;
  server: Server;
  token: string;
}

let cachedModelCatalog: { key: string; catalog: AgentModelCatalog } | null =
  null;
const SESSION_MODEL_DISCOVERY_TTL_MS = 60_000;
let cachedSessionDiscoveredModels: {
  key: string;
  models: AvailableModel[];
  fetchedAt: number;
} | null = null;

function resolveAcpAuthMethodId(
  authMethods: readonly { id: string }[],
  env: Record<string, string | undefined>,
): string | undefined {
  const methodIds = new Set(authMethods.map((method) => method.id));
  if (methodIds.size === 0) {
    return undefined;
  }
  if (env.XAI_API_KEY && methodIds.has("xai.api_key")) {
    return "xai.api_key";
  }
  if (methodIds.has("cached_token")) {
    return "cached_token";
  }
  return undefined;
}

async function authenticateAcpAgent(args: {
  connection: AcpAgentConnection;
  env: Record<string, string | undefined>;
  capabilities: AcpAgentCapabilities;
}): Promise<void> {
  const methodId = resolveAcpAuthMethodId(
    args.capabilities.authMethods,
    args.env,
  );
  if (methodId === undefined) {
    return;
  }
  try {
    await args.connection.request({
      method: "authenticate",
      params: { methodId, _meta: { headless: true } },
      resultSchema: z.unknown(),
      timeoutMs: ACP_AUTHENTICATE_TIMEOUT_MS,
    });
  } catch (error) {
    throw new AcpAuthRequiredError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function loadAgentModelCatalog(
  listCommand: AcpAgentCommandParam,
): Promise<AgentModelCatalog | null> {
  const stdout = await execPortableFile(listCommand.command, listCommand.args, {
    cwd: listCommand.cwd ?? process.cwd(),
    env: {
      ...agentProcessEnv(process.env),
      ...(listCommand.envVars ?? {}),
    },
    maxBuffer: 1024 * 1024,
    timeout: MODEL_LIST_TIMEOUT_MS,
  }).then(
    ({ stdout }) => stdout,
    (error: unknown) => {
      if (isMissingExecutableError(error)) throw error;
      const output = z
        .object({ stdout: z.string(), stderr: z.string() })
        .safeParse(error);
      if (
        isAuthRequiredModelListError(
          error,
          output.success ? output.data.stdout : "",
          output.success ? output.data.stderr : "",
        )
      ) {
        throw new AcpModelListAuthRequiredError();
      }
      return null;
    },
  );
  const key = JSON.stringify(listCommand);
  if (stdout === null) {
    log(`acp bridge: model list command "${listCommand.command}" failed\n`);
    return cachedModelCatalog?.key === key ? cachedModelCatalog.catalog : null;
  }
  const catalog = buildAgentModelCatalog(parseAgentModelLines(stdout));
  if (!catalog) {
    log(
      `acp bridge: model list command "${listCommand.command}" printed no models\n`,
    );
    return cachedModelCatalog?.key === key ? cachedModelCatalog.catalog : null;
  }
  cachedModelCatalog = { key, catalog };
  return catalog;
}

let cachedDeclaredSessionOptions: {
  key: string;
  options: ThreadSessionOption[];
  fetchedAt: number;
} | null = null;

function declaredSessionOptionsKey(
  agent: AcpAgentCommandParam,
  parameterizedModelPicker: boolean,
): string {
  return JSON.stringify({ agent, parameterizedModelPicker });
}

function rememberDeclaredSessionOptions(
  key: string,
  sessionSetup: unknown,
): void {
  const model = createAcpSessionModel({ generation: 1 });
  if (isJsonObject(sessionSetup)) {
    model.applySessionSetup(sessionSetup);
  }
  cachedDeclaredSessionOptions = {
    key,
    options: toThreadSessionOptionsState(model.snapshot().configOptions)
      .options,
    fetchedAt: Date.now(),
  };
}

function freshDeclaredSessionOptions(
  key: string,
): ThreadSessionOption[] | null {
  return cachedDeclaredSessionOptions?.key === key &&
    Date.now() - cachedDeclaredSessionOptions.fetchedAt <
      SESSION_MODEL_DISCOVERY_TTL_MS
    ? cachedDeclaredSessionOptions.options
    : null;
}

async function loadDeclaredSessionOptions(
  agent: AcpAgentCommandParam,
  parameterizedModelPicker: boolean,
): Promise<ThreadSessionOption[]> {
  const key = declaredSessionOptionsKey(agent, parameterizedModelPicker);
  const cached = freshDeclaredSessionOptions(key);
  if (cached !== null) {
    return cached;
  }
  const childEnv = {
    ...agentProcessEnv(process.env),
    ...(agent.envVars ?? {}),
  };
  const connection = createAcpAgentConnection({
    command: agent.command,
    args: agent.args,
    cwd: agent.cwd ?? process.cwd(),
    env: childEnv,
    onResponse: (method, result) => {
      if (method === "session/new") {
        rememberDeclaredSessionOptions(key, result);
      }
    },
    onNotification: () => {},
    onRequest: (_method, _params, responder) => {
      responder.error(-32601, "ACP option discovery does not support requests");
    },
    onExit: () => {},
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutReached = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      connection.kill();
      reject(
        new Error(
          `ACP option discovery timed out after ${MODEL_LIST_TIMEOUT_MS}ms`,
        ),
      );
    }, MODEL_LIST_TIMEOUT_MS);
  });
  try {
    await Promise.race([
      (async () => {
        const capabilities = await requestAcpInitialize(connection, {
          parameterizedModelPicker,
          fsAccess: false,
        });
        await authenticateAcpAgent({
          connection,
          env: childEnv,
          capabilities,
        });
        await connection.request({
          method: "session/new",
          params: { cwd: agent.cwd ?? process.cwd(), mcpServers: [] },
          resultSchema: z.unknown(),
        });
      })(),
      timeoutReached,
    ]);
  } catch (error) {
    log(
      `acp bridge: ACP option discovery for "${agent.command}" failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    await connection.kill();
  }
  return settleDeclaredSessionOptions(key);
}

function settleDeclaredSessionOptions(key: string): ThreadSessionOption[] {
  const discovered = freshDeclaredSessionOptions(key);
  if (discovered !== null) {
    return discovered;
  }
  cachedDeclaredSessionOptions = { key, options: [], fetchedAt: Date.now() };
  return [];
}

async function loadSessionDiscoveredModels(
  agent: AcpAgentCommandParam,
  reasoningProbePriorityModelIds: readonly string[],
  parameterizedModelPicker: boolean,
): Promise<AvailableModel[] | null> {
  const key = JSON.stringify({
    agent,
    reasoningProbePriorityModelIds,
    parameterizedModelPicker,
  });
  if (
    cachedSessionDiscoveredModels?.key === key &&
    Date.now() - cachedSessionDiscoveredModels.fetchedAt <
      SESSION_MODEL_DISCOVERY_TTL_MS
  ) {
    return cachedSessionDiscoveredModels.models;
  }

  const childEnv = {
    ...agentProcessEnv(process.env),
    ...(agent.envVars ?? {}),
  };
  const connection = createAcpAgentConnection({
    command: agent.command,
    args: agent.args,
    cwd: agent.cwd ?? process.cwd(),
    env: childEnv,
    onResponse: (method, result) => {
      if (method === "session/new") {
        rememberDeclaredSessionOptions(
          declaredSessionOptionsKey(agent, parameterizedModelPicker),
          result,
        );
      }
    },
    onNotification: () => {},
    onRequest: (_method, _params, responder) => {
      responder.error(-32601, "ACP model discovery does not support requests");
    },
    onExit: () => {},
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutReached = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      connection.kill();
      reject(
        new Error(
          `The agent did not answer within ${MODEL_LIST_TIMEOUT_MS / 1000} seconds while bb asked it for its models`,
        ),
      );
    }, MODEL_LIST_TIMEOUT_MS);
  });

  let discoveredCapabilities: AcpAgentCapabilities | null = null;
  try {
    const newSession = await Promise.race([
      (async () => {
        const capabilities = await requestAcpInitialize(connection, {
          parameterizedModelPicker,
          fsAccess: false,
        });
        discoveredCapabilities = capabilities;
        await authenticateAcpAgent({
          connection,
          env: childEnv,
          capabilities,
        });
        return await connection.request({
          method: "session/new",
          params: { cwd: agent.cwd ?? process.cwd(), mcpServers: [] },
          resultSchema: acpSessionNewResultSchema,
        });
      })(),
      timeoutReached,
    ]);
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }

    const modelOption = findAcpModelConfigOption(newSession.configOptions);
    const configOptionModels = buildModelCatalogFromConfigOptions(modelOption);
    const sessionModels = buildModelCatalogFromSessionModels(newSession.models);
    if (configOptionModels.length === 0 && sessionModels.length === 0) {
      return null;
    }

    if (configOptionModels.length === 0) {
      cachedSessionDiscoveredModels = {
        key,
        models: sessionModels,
        fetchedAt: Date.now(),
      };
      return sessionModels;
    }

    const reasoningByModel = await discoverAcpNativeReasoningByModel({
      connection,
      sessionId: newSession.sessionId,
      modelOption,
      reasoningProbePriorityModelIds,
    });
    const models = buildModelCatalogFromConfigOptions(
      modelOption,
      reasoningByModel,
    );
    cachedSessionDiscoveredModels = {
      key,
      models,
      fetchedAt: Date.now(),
    };
    return models;
  } catch (error) {
    log(
      `acp bridge: ACP-native model discovery for "${agent.command}" failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    throw withAcpSignInGuidance(error, {
      command: agent.command,
      args: agent.args,
      capabilities: discoveredCapabilities,
    });
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    await connection.kill();
    settleDeclaredSessionOptions(
      declaredSessionOptionsKey(agent, parameterizedModelPicker),
    );
  }
}

async function discoverAcpNativeReasoningByModel(args: {
  connection: AcpAgentConnection;
  sessionId: string;
  modelOption: AcpConfigOption | undefined;
  reasoningProbePriorityModelIds: readonly string[];
}): Promise<ReadonlyMap<string, AcpNativeReasoningSupport>> {
  const modelOptions = args.modelOption?.options ?? [];
  if (!args.modelOption || modelOptions.length === 0) {
    return new Map();
  }
  const modelOption = args.modelOption;
  const modelByValue = new Map(
    modelOptions.map((model) => [model.value, model] as const),
  );
  const modelsToProbe: typeof modelOptions = [];
  const addedModels = new Set<string>();
  for (const value of args.reasoningProbePriorityModelIds) {
    const model = modelByValue.get(value);
    if (model && !addedModels.has(model.value)) {
      modelsToProbe.push(model);
      addedModels.add(model.value);
    }
  }
  for (const model of modelOptions) {
    if (!addedModels.has(model.value)) {
      modelsToProbe.push(model);
    }
  }

  const supportByModel = new Map<string, AcpNativeReasoningSupport>();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutReached = new Promise<
    ReadonlyMap<string, AcpNativeReasoningSupport>
  >((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      args.connection.kill();
      resolve(supportByModel);
    }, ACP_NATIVE_REASONING_DISCOVERY_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      (async () => {
        for (const model of modelsToProbe) {
          try {
            const configState = await args.connection.request({
              method: "session/set_config_option",
              params: {
                sessionId: args.sessionId,
                configId: modelOption.id,
                value: model.value,
              },
              resultSchema: acpConfigStateResultSchema,
            });
            supportByModel.set(
              model.value,
              buildAcpNativeReasoningSupport(
                findAcpThoughtLevelConfigOption(configState.configOptions),
              ),
            );
          } catch (error) {
            if (timedOut) {
              break;
            }
            log(
              `acp bridge: ACP-native reasoning discovery for model "${model.value}" failed: ${
                error instanceof Error ? error.message : String(error)
              }\n`,
            );
          }
        }
        return supportByModel;
      })(),
      timeoutReached,
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function isMissingExecutableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT" &&
    "syscall" in error &&
    typeof error.syscall === "string" &&
    error.syscall.startsWith("spawn")
  );
}

export class AcpAuthRequiredError extends RunnerError {
  constructor(message: string) {
    super("auth_required", message);
    this.name = "AcpAuthRequiredError";
  }
}

class AcpModelListAuthRequiredError extends AcpAuthRequiredError {
  constructor() {
    super(AUTH_REQUIRED_MODEL_LIST_ERROR_MESSAGE);
    this.name = "AcpModelListAuthRequiredError";
  }
}

function isAcpAuthRequiredText(...texts: readonly string[]): boolean {
  const text = texts.join("\n");
  return (
    text.includes("Authentication required") &&
    (text.includes("agent login") ||
      text.includes("CURSOR_API_KEY") ||
      text.includes("CURSOR_AUTH_TOKEN") ||
      text.includes("auth token") ||
      text.includes("api key") ||
      text.includes("login"))
  );
}

function isAuthRequiredModelListError(
  error: unknown,
  stdout: string,
  stderr: string,
): boolean {
  return isAcpAuthRequiredText(
    error instanceof Error ? error.message : String(error),
    stdout,
    stderr,
  );
}

const ACP_AUTH_REQUIRED_ERROR_CODE = -32000;
const ACP_AUTH_REQUIRED_ERROR_MESSAGE = "Authentication required";

function isAcpAuthRequiredResponse(error: unknown): boolean {
  return (
    error instanceof AcpAgentResponseError &&
    error.code === ACP_AUTH_REQUIRED_ERROR_CODE &&
    error.message.startsWith(ACP_AUTH_REQUIRED_ERROR_MESSAGE)
  );
}

function withAcpAuthRequiredRecovery(error: unknown): unknown {
  if (error instanceof AcpAuthRequiredError) return error;
  if (
    error instanceof Error &&
    (isAcpAuthRequiredResponse(error) || isAcpAuthRequiredText(error.message))
  ) {
    return new AcpAuthRequiredError(error.message);
  }
  return error;
}

function withAcpSignInGuidance(
  error: unknown,
  agent: {
    command: string;
    args: readonly string[];
    capabilities: AcpAgentCapabilities | null | undefined;
  },
): unknown {
  const typed = withAcpAuthRequiredRecovery(error);
  if (!(typed instanceof AcpAuthRequiredError)) {
    return error;
  }
  const guidance = agent.capabilities
    ? describeAcpSignIn({
        command: agent.command,
        args: agent.args,
        authMethods: agent.capabilities.authMethods,
      })
    : null;
  return guidance === null
    ? typed
    : new AcpAuthRequiredError(
        `${typed.message.replace(/[\s.!?:;]*$/u, "")}. ${guidance}`,
      );
}

async function resolveAgentLaunchArgs(
  params: AcpSessionParams,
): Promise<{ args: string[]; warning: string | undefined }> {
  const selection = params.modelSelection;
  const agentArgs = applyPermissionCliArgs(
    params.agent.args,
    params.permissionCli,
    params.permissionMode,
  );
  const prefixArgs: string[] = [];
  let warning: string | undefined;

  if (selection && "selectFlag" in selection) {
    let resolved: string | undefined;
    const variantReasoningLevel =
      params.reasoningCli === undefined ? selection.reasoningLevel : undefined;
    if (
      variantReasoningLevel !== undefined ||
      selection.serviceTier === "fast"
    ) {
      const key = JSON.stringify(selection.listCommand);
      const catalog =
        cachedModelCatalog?.key === key
          ? cachedModelCatalog.catalog
          : await loadAgentModelCatalog(selection.listCommand);
      resolved = catalog?.resolveVariant({
        model: selection.model,
        reasoningLevel: variantReasoningLevel,
        serviceTier: selection.serviceTier,
      });
      if (resolved === undefined && variantReasoningLevel !== undefined) {
        warning = `Model "${selection.model}" has no ${variantReasoningLevel} reasoning variant; launching it at its default effort.`;
      }
    }
    prefixArgs.push(selection.selectFlag, resolved ?? selection.model);
  }

  if (
    params.reasoningCli !== undefined &&
    params.launchReasoningLevel !== undefined
  ) {
    const reasoningValue = resolveHintReasoningValue({
      hint: params.reasoningCli,
      reasoningLevel: params.launchReasoningLevel,
    });
    if (reasoningValue !== undefined) {
      prefixArgs.push(params.reasoningCli.flag, reasoningValue);
    } else if (warning === undefined) {
      warning = `Reasoning level "${params.launchReasoningLevel}" is not supported by this ACP agent's launch flag; launching it at its default effort.`;
    }
  }

  return {
    args: [...prefixArgs, ...agentArgs],
    warning,
  };
}

async function selectAcpNativeModel(args: {
  session: AcpThreadSession;
  sessionId: string;
  modelSelection: AcpSessionParams["modelSelection"];
  nativeReasoning: AcpBridgeNativeReasoning | undefined;
}): Promise<void> {
  const selection = args.modelSelection;
  if (!selection || !("modelId" in selection)) {
    return;
  }
  const { session } = args;
  const { configOptions, models } = session.nativeConfig;
  const modelOption = findAcpModelConfigOption(configOptions);
  const availableSessionModels = models?.availableModels ?? [];
  const sessionModelsIncludeSelection = availableSessionModels.some(
    (model) => model.modelId === selection.modelId,
  );
  const shouldSetModel =
    (modelOption && modelOption.currentValue !== selection.modelId) ||
    (!modelOption &&
      sessionModelsIncludeSelection &&
      models?.currentModelId !== selection.modelId);
  if (shouldSetModel) {
    let configState: AcpConfigStateResult | null = null;
    let setModel = true;
    if (modelOption) {
      try {
        configState = await session.connection.request({
          method: "session/set_config_option",
          params: {
            sessionId: args.sessionId,
            configId: modelOption.id,
            value: selection.modelId,
          },
          resultSchema: z.union([acpConfigStateResultSchema, z.null()]),
          timeoutMs: ACP_SESSION_CONFIG_TIMEOUT_MS,
        });
        setModel = false;
      } catch {
        setModel = true;
      }
    }
    if (setModel) {
      configState = await session.connection.request({
        method: "session/set_model",
        params: { sessionId: args.sessionId, modelId: selection.modelId },
        resultSchema: z.union([acpConfigStateResultSchema, z.null()]),
        timeoutMs: ACP_SESSION_CONFIG_TIMEOUT_MS,
      });
    }
    const current = session.nativeConfig;
    session.nativeConfig = {
      configOptions:
        configState?.configOptions ??
        withAcpConfigValue(
          current.configOptions,
          modelOption?.id,
          selection.modelId,
        ),
      models:
        configState?.models ??
        (current.models && {
          ...current.models,
          currentModelId: selection.modelId,
        }),
    };
  }
  await selectAcpNativeReasoning({
    session,
    sessionId: args.sessionId,
    modelSelection: selection,
    nativeReasoning: args.nativeReasoning,
  });
  await selectAcpNativeServiceTier({
    session,
    sessionId: args.sessionId,
    modelSelection: selection,
  });
}

function withAcpConfigValue(
  configOptions: readonly AcpConfigOption[] | undefined,
  configId: string | undefined,
  value: string,
): readonly AcpConfigOption[] | undefined {
  return configOptions?.map((option) =>
    option.id === configId ? { ...option, currentValue: value } : option,
  );
}

function recordAcpConfigValue(
  session: AcpThreadSession,
  configState: AcpConfigStateResult | null,
  configId: string,
  value: string,
): void {
  session.nativeConfig = {
    ...session.nativeConfig,
    configOptions:
      configState?.configOptions ??
      withAcpConfigValue(session.nativeConfig.configOptions, configId, value),
  };
}

function acpNativeModelDrifted(
  nativeConfig: AcpNativeConfigState,
  modelSelection: AcpSessionParams["modelSelection"],
): boolean {
  if (!modelSelection || !("modelId" in modelSelection)) {
    return false;
  }
  const currentModelId =
    findAcpModelConfigOption(nativeConfig.configOptions)?.currentValue ??
    nativeConfig.models?.currentModelId;
  return (
    currentModelId !== undefined && currentModelId !== modelSelection.modelId
  );
}

async function selectAcpNativeReasoning(args: {
  session: AcpThreadSession;
  sessionId: string;
  modelSelection: Extract<
    AcpSessionParams["modelSelection"],
    { modelId: string }
  >;
  nativeReasoning: AcpBridgeNativeReasoning | undefined;
}): Promise<void> {
  const reasoningLevel = args.modelSelection.reasoningLevel;
  if (reasoningLevel === undefined) {
    return;
  }
  const thoughtLevelOption =
    findAcpThoughtLevelConfigOption(args.session.nativeConfig.configOptions) ??
    nativeReasoningToThoughtLevelOption(args.nativeReasoning);
  if (!thoughtLevelOption) {
    return;
  }
  const value = acpNativeReasoningLevelToValue(
    reasoningLevel,
    thoughtLevelOption,
  );
  if (value === undefined) {
    return;
  }
  let configState: AcpConfigStateResult | null;
  try {
    configState = await args.session.connection.request({
      method: "session/set_config_option",
      params: {
        sessionId: args.sessionId,
        configId: thoughtLevelOption.id,
        value,
      },
      resultSchema: z.union([acpConfigStateResultSchema, z.null()]),
      timeoutMs: ACP_SESSION_CONFIG_TIMEOUT_MS,
    });
  } catch {
    return;
  }
  recordAcpConfigValue(args.session, configState, thoughtLevelOption.id, value);
}

async function selectAcpNativeServiceTier(args: {
  session: AcpThreadSession;
  sessionId: string;
  modelSelection: Extract<
    AcpSessionParams["modelSelection"],
    { modelId: string }
  >;
}): Promise<void> {
  const serviceTier = args.modelSelection.serviceTier;
  if (serviceTier === undefined) {
    return;
  }
  const fastOption = (args.session.nativeConfig.configOptions ?? []).find(
    (option) => option.id === "fast" && option.type === "select",
  );
  const value = serviceTier === "fast" ? "true" : "false";
  if (!fastOption?.options?.some((option) => option.value === value)) {
    return;
  }
  const configState = await args.session.connection.request({
    method: "session/set_config_option",
    params: {
      sessionId: args.sessionId,
      configId: fastOption.id,
      value,
    },
    resultSchema: z.union([acpConfigStateResultSchema, z.null()]),
    timeoutMs: ACP_SESSION_CONFIG_TIMEOUT_MS,
  });
  recordAcpConfigValue(args.session, configState, fastOption.id, value);
}

function textWithoutUnknownLeadingSkillCommand(
  session: AcpThreadSession,
  item: Extract<PromptInput, { type: "text" }>,
): string {
  const advertised = session.model.snapshot().commands;
  if (advertised.length === 0) {
    return item.text;
  }
  const firstCharacter = item.text.search(/\S/u);
  const leading = item.mentions.find(
    (mention) =>
      mention.start === firstCharacter &&
      mention.resource.kind === "command" &&
      mention.resource.source === "skill" &&
      mention.resource.trigger === "/",
  );
  if (!leading || leading.resource.kind !== "command") {
    return item.text;
  }
  const name = leading.resource.name;
  if (advertised.some((command) => command.name === name)) {
    return item.text;
  }
  return `${item.text.slice(0, leading.start)}Use the bb skill "${name}":${item.text.slice(leading.end)}`;
}

function buildPromptContentBlocks(
  session: AcpThreadSession,
  input: PromptInput[],
): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = [];

  const instructions = session.pendingInstructions;
  if (instructions) {
    session.pendingInstructions = undefined;
    blocks.push({
      type: "text",
      text: `<system_instructions>\n${instructions}\n</system_instructions>`,
    });
  }

  for (const [index, item] of input.entries()) {
    switch (item.type) {
      case "text":
        blocks.push({
          type: "text",
          text:
            index === 0
              ? textWithoutUnknownLeadingSkillCommand(session, item)
              : item.text,
        });
        break;
      case "image":
        blocks.push({ type: "text", text: `[image attachment: ${item.url}]` });
        break;
      case "localImage": {
        if (!session.supportsImageInput) {
          blocks.push({
            type: "text",
            text: `[image attachment on disk: ${item.path}]`,
          });
          break;
        }
        try {
          const data = readFileSync(item.path).toString("base64");
          blocks.push({
            type: "image",
            data,
            mimeType: mimeTypeFromExtension(item.path),
          });
        } catch {
          blocks.push({
            type: "text",
            text: `[unreadable image attachment: ${item.path}]`,
          });
        }
        break;
      }
      case "localFile":
        blocks.push({
          type: "resource_link",
          uri: `file://${item.path}`,
          name: item.name ?? basename(item.path),
        });
        break;
    }
  }

  return blocks;
}

function findOptionIdByKinds(
  options: AcpPermissionOption[],
  kinds: AcpPermissionOption["kind"][],
): string | undefined {
  for (const kind of kinds) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) {
      return option.optionId;
    }
  }
  return undefined;
}

function pickPermissionOptionId(
  options: AcpPermissionOption[],
  decision: "allow_once" | "allow_for_session" | "deny",
): string | undefined {
  switch (decision) {
    case "allow_once":
      return findOptionIdByKinds(options, ["allow_once", "allow_always"]);
    case "allow_for_session":
      return findOptionIdByKinds(options, ["allow_always", "allow_once"]);
    case "deny":
      return findOptionIdByKinds(options, ["reject_once", "reject_always"]);
  }
}

function respondPermission(
  pending: PendingAcpPermission,
  decision: "allow_once" | "allow_for_session" | "deny" | null,
): void {
  if (decision === null) {
    pending.responder.result({ outcome: { outcome: "cancelled" } });
    return;
  }
  const optionId = pickPermissionOptionId(pending.options, decision);
  if (optionId === undefined) {
    pending.responder.result({ outcome: { outcome: "cancelled" } });
    return;
  }
  pending.responder.result({ outcome: { outcome: "selected", optionId } });
}

function cancelPendingPermissions(session: AcpThreadSession): void {
  for (const pending of session.pendingPermissions) {
    pending.responder.result({ outcome: { outcome: "cancelled" } });
  }
  session.pendingPermissions.clear();
  for (const responder of session.pendingElicitations) {
    responder.result({ action: "cancel" });
  }
  session.pendingElicitations.clear();
}

function requestInteraction(
  session: AcpThreadSession,
  payload: PendingInteractionPayload,
): Promise<unknown> {
  const output = outputsByBbThreadId.get(session.bbThreadId);
  if (!output) {
    return Promise.reject(new Error("No active ACP session"));
  }
  return output.requestInteraction(payload);
}

function handleElicitationRequest(
  session: AcpThreadSession,
  params: unknown,
  responder: AcpAgentRequestResponder,
): void {
  if (
    session.stopping ||
    session.cancelRequested ||
    session.activePromptKind === "compaction"
  ) {
    responder.result({ action: "cancel" });
    return;
  }
  const plan = planAcpElicitation(params);
  if (plan.kind === "unsupported") {
    session.translator.warning({
      summary: "The agent asked a question bb could not show",
      details: `The request was declined because ${plan.reason}.`,
    });
    responder.result({ action: "decline" });
    return;
  }
  if (session.activePromptKind === null) {
    openAgentTurn(session);
  }
  session.pendingElicitations.add(responder);
  void requestInteraction(session, plan.payload)
    .then((result) => {
      if (!session.pendingElicitations.delete(responder)) {
        return;
      }
      const resolution =
        userQuestionPendingInteractionResolutionSchema.safeParse(result);
      responder.result(
        resolution.success
          ? plan.toResponse(resolution.data)
          : { action: "cancel" },
      );
    })
    .catch(() => {
      if (!session.pendingElicitations.delete(responder)) {
        return;
      }
      responder.result({ action: "cancel" });
    });
}

function handlePermissionRequest(
  session: AcpThreadSession,
  params: unknown,
  responder: AcpAgentRequestResponder,
): void {
  const parsed = acpRequestPermissionParamsSchema.safeParse(params);
  if (!parsed.success) {
    responder.error(-32602, "Invalid session/request_permission params");
    return;
  }

  if (
    session.stopping ||
    session.cancelRequested ||
    session.activePromptKind === "compaction"
  ) {
    responder.result({ outcome: { outcome: "cancelled" } });
    return;
  }

  const toolCall = parsed.data.toolCall;
  const bound =
    toolCall?.toolCallId !== undefined
      ? session.translator.notePermissionToolCall(session.bbThreadId, {
          toolCallId: toolCall.toolCallId,
          ...(toolCall.title !== undefined ? { title: toolCall.title } : {}),
          ...(toolCall.kind !== undefined ? { kind: toolCall.kind } : {}),
          ...(toolCall.rawKind !== undefined
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
        })
      : undefined;
  const pending: PendingAcpPermission = {
    responder,
    options: parsed.data.options,
  };

  if (session.policy.permissionMode === "full") {
    respondPermission(pending, "allow_once");
    return;
  }

  if (session.activePromptKind === null) {
    openAgentTurn(session);
  }
  session.pendingPermissions.add(pending);

  const normalizedToolCall =
    toolCall?.toolCallId !== undefined && bound !== undefined
      ? {
          toolCallId: bound.toolCallId,
          ...(toolCall.title !== undefined ? { title: toolCall.title } : {}),
          ...(toolCall.kind !== undefined ? { kind: toolCall.kind } : {}),
          ...(toolCall.rawKind !== undefined
            ? { rawKind: toolCall.rawKind }
            : {}),
          ...(toolCall.content !== undefined
            ? { content: toolCall.content }
            : {}),
          ...(toolCall.rawInput !== undefined
            ? { rawInput: toolCall.rawInput }
            : {}),
          ...(toolCall.locations !== undefined
            ? { locations: toolCall.locations }
            : {}),
          startedToolCall: bound.event,
          injectedTool: session.translator.getInjectedToolBinding(
            session.bbThreadId,
            bound.toolCallId,
          ),
        }
      : undefined;

  const payload = buildAcpPermissionInteractionPayload({
    toolCall: normalizedToolCall,
    options: parsed.data.options,
    cwd: session.cwd,
    classifyToolCall: session.dialect.classifyToolCall,
  });
  void requestInteraction(session, payload)
    .then((result) => {
      if (!session.pendingPermissions.delete(pending)) {
        return;
      }
      const resolution = pendingInteractionResolutionSchema.safeParse(result);
      const response = resolution.success
        ? resolveAcpPermissionDecision({
            payload,
            resolution: resolution.data,
          })
        : null;
      respondPermission(pending, response?.decision ?? null);
    })
    .catch(() => {
      if (!session.pendingPermissions.delete(pending)) {
        return;
      }
      respondPermission(pending, null);
    });
}

function isPathInsideRoots(targetPath: string, roots: string[]): boolean {
  const resolvedTarget = resolve(targetPath);
  return roots.some((root) => {
    const relativePath = relative(resolve(root), resolvedTarget);
    return (
      relativePath === "" ||
      (!relativePath.startsWith("..") && !isAbsolute(relativePath))
    );
  });
}

function sliceFileContent(
  content: string,
  line: number | null | undefined,
  limit: number | null | undefined,
): string {
  if (line == null && limit == null) {
    return content;
  }
  const lines = content.split("\n");
  const startIndex = line == null ? 0 : Math.max(0, line - 1);
  const endIndex = limit == null ? lines.length : startIndex + limit;
  return lines.slice(startIndex, endIndex).join("\n");
}

async function handleFsReadTextFile(
  params: unknown,
  responder: AcpAgentRequestResponder,
): Promise<void> {
  const parsed = acpReadTextFileParamsSchema.safeParse(params);
  if (!parsed.success) {
    responder.error(-32602, "Invalid fs/read_text_file params");
    return;
  }
  try {
    const content = await fs.readFile(parsed.data.path, "utf8");
    responder.result({
      content: sliceFileContent(content, parsed.data.line, parsed.data.limit),
    });
  } catch (error) {
    responder.error(
      -32603,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handleFsWriteTextFile(
  session: AcpThreadSession,
  params: unknown,
  responder: AcpAgentRequestResponder,
): Promise<void> {
  const parsed = acpWriteTextFileParamsSchema.safeParse(params);
  if (!parsed.success) {
    responder.error(-32602, "Invalid fs/write_text_file params");
    return;
  }

  if (
    session.policy.permissionMode === "accept-edits" &&
    !isPathInsideRoots(parsed.data.path, session.policy.workspaceWriteRoots)
  ) {
    responder.error(
      -32000,
      `File writes outside the workspace are denied by BB's accept-edits permission mode: ${parsed.data.path}`,
    );
    return;
  }

  try {
    let oldText: string | undefined;
    try {
      oldText = await fs.readFile(parsed.data.path, "utf8");
    } catch {
      oldText = undefined;
    }
    await fs.mkdir(dirname(parsed.data.path), { recursive: true });
    await fs.writeFile(parsed.data.path, parsed.data.content, "utf8");

    session.translator.fileWritten({
      path: parsed.data.path,
      kind: oldText === undefined ? "add" : "update",
      ...(oldText === undefined ? {} : { oldText }),
      content: parsed.data.content,
    });
    responder.result({});
  } catch (error) {
    responder.error(
      -32603,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function liveSessionForThread(
  bbThreadId: string,
): AcpThreadSession | undefined {
  const session = sessionsByBbThreadId.get(bbThreadId);
  if (!session || session.stopping || session.providerThreadId === "") {
    return undefined;
  }
  return session;
}

function removeSession(session: AcpThreadSession): void {
  for (const controller of session.pendingToolCalls) controller.abort();
  if (sessionsByBbThreadId.get(session.bbThreadId) === session) {
    sessionsByBbThreadId.delete(session.bbThreadId);
  }
  if (
    bbThreadIdByProviderThreadId.get(session.providerThreadId) ===
    session.bbThreadId
  ) {
    bbThreadIdByProviderThreadId.delete(session.providerThreadId);
  }
}

async function releaseCursorMcpApproval(
  session: AcpThreadSession,
): Promise<void> {
  const approval = session.cursorMcpApproval;
  session.cursorMcpApproval = undefined;
  if (!approval) {
    return;
  }
  try {
    await revokeCursorSessionMcpServer(approval);
  } catch (error) {
    log(
      `acp bridge: failed to remove Cursor session MCP approval for thread "${session.bbThreadId}": ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

function getSessionByProviderThreadId(
  providerThreadId: string,
): AcpThreadSession | undefined {
  const bbThreadId = bbThreadIdByProviderThreadId.get(providerThreadId);
  return bbThreadId ? sessionsByBbThreadId.get(bbThreadId) : undefined;
}

type AcpSessionStartRequest =
  | { kind: "start"; params: AcpSessionParams }
  | {
      kind: "resume";
      params: AcpSessionParams;
      resumeProviderThreadId: string;
    }
  | {
      kind: "fork";
      params: AcpSessionParams;
      sourceProviderThreadId: string;
    };

async function startAgentSession(
  request: AcpSessionStartRequest,
): Promise<AcpThreadSession> {
  const params = request.params;
  const bbThreadId = params.threadId;

  const existing = sessionsByBbThreadId.get(bbThreadId);
  if (existing) {
    await stopSession(existing);
  }

  const dialect = resolveAcpDialect({
    ...(params.dialectId === undefined ? {} : { dialectId: params.dialectId }),
    command: params.agent.command,
  });
  const translator = createAcpTranslator({
    threadId: bbThreadId,
    events: () => sessionEvents(bbThreadId),
    cwd: params.cwd,
    dialect,
  });
  translator.configureInjectedTools(
    (params.dynamicTools ?? []).map((tool) => ({
      name: tool.name,
      ...(tool.presentation === undefined
        ? {}
        : { presentation: tool.presentation }),
    })),
  );
  const deferredEmits: {
    emit: (session: AcpThreadSession) => void;
    sessionId: string | undefined;
  }[] = [];
  const emitStartNotification: AcpDeferredStartEmitter = (emit, sessionId) => {
    deferredEmits.push({ emit, sessionId });
  };

  const launch = await resolveAgentLaunchArgs(params);
  const launchWarning = launch.warning;
  if (launchWarning) {
    emitStartNotification((started) =>
      started.translator.warning({ summary: launchWarning }),
    );
  }
  const agentLabel = [params.agent.command, ...params.agent.args].join(" ");
  let session: AcpThreadSession;
  const childEnv = {
    ...agentProcessEnv(process.env),
    ...params.envVars,
    ...(dialect.id === "opencode"
      ? { OPENCODE_CLIENT: "acp", OPENCODE_ENABLE_QUESTION_TOOL: "false" }
      : {}),
  };
  const connection = createAcpAgentConnection({
    command: params.agent.command,
    args: launch.args,
    cwd: params.cwd,
    env: childEnv,
    requestMethods: [
      ...ACP_CORE_CLIENT_REQUEST_METHODS,
      ...(dialect.clientRequestMethods ?? []),
    ],
    onResponse: (method, result) => noteAgentResponse(session, method, result),
    onNotification: (method, notificationParams) =>
      handleAgentNotification(session, method, notificationParams),
    onRequest: (method, requestParams, responder) =>
      handleAgentRequest(session, method, requestParams, responder),
    onExit: (info) => {
      const wasCurrent = sessionsByBbThreadId.get(bbThreadId) === session;
      cancelPendingPermissions(session);
      if (!wasCurrent || session.stopping || session.providerThreadId === "") {
        removeSession(session);
        return;
      }
      void releaseCursorMcpApproval(session);
      emitSessionError(
        session,
        `ACP agent "${agentLabel}" exited unexpectedly` +
          `${info.code !== null ? ` (code ${info.code})` : ""}` +
          `${info.stderrTail ? `: ${info.stderrTail}` : ""}`,
      );
      setActivePromptKind(session, null);
    },
  });
  session = {
    bbThreadId,
    construction: params,
    nativeConfig: { configOptions: undefined, models: undefined },
    providerThreadId: "",
    cwd: params.cwd,
    dialect,
    translator,
    connection,
    model: createAcpSessionModel({ generation: 1 }),
    promptWorkOpen: false,
    agentTurnQuietTimer: undefined,
    agentUpdateCount: 0,
    turnOutputCount: 0,
    publishedThreadState: new Map(),
    capabilities: undefined,
    supportsImageInput: false,
    supportsLoadSession: false,
    policy: {
      permissionMode: params.permissionMode,
      workspaceWriteRoots: params.workspaceWriteRoots,
    },
    pendingInstructions: params.instructions,
    activePromptKind: null,
    compactionAgentMessage: "",
    queuedInputs: [],
    promptRequestPending: false,
    cancelRequested: false,
    restartAfterCancelError: false,
    loading: false,
    loadingSessionId: undefined,
    pendingLoadUsageUpdate: undefined,
    grokContextWindowSize: undefined,
    stopping: false,
    turnSettled: undefined,
    pendingPermissions: new Set(),
    pendingElicitations: new Set(),
    pendingToolCalls: new Set(),
    cursorMcpApproval: undefined,
    deferStartEmit: emitStartNotification,
    awaitingFirstPrompt: true,
  };
  sessionsByBbThreadId.set(bbThreadId, session);

  try {
    const capabilities = await requestAcpInitialize(connection, {
      parameterizedModelPicker: params.parameterizedModelPicker,
      fsAccess: true,
      elicitation: true,
    });
    session.capabilities = capabilities;
    await authenticateAcpAgent({
      connection,
      env: childEnv,
      capabilities,
    });
    session.supportsImageInput = capabilities.prompt.image;
    const supportsLoadSession = capabilities.session.load;
    const supportsFork = capabilities.session.fork;
    if (request.kind === "fork" && !supportsFork) {
      throw new Error(
        `ACP agent "${agentLabel}" does not advertise session/fork support.`,
      );
    }
    session.supportsLoadSession =
      supportsLoadSession || capabilities.session.resume;
    const mcpServers = await buildSessionMcpServers(params);
    const mcpServer = mcpServers[0];
    if (mcpServer) {
      session.cursorMcpApproval = await approveCursorSessionMcpServer({
        agentCommand: params.agent.command,
        config: mcpServer,
        cwd: params.cwd,
        env: childEnv,
      });
      if (session.cursorMcpApproval?.installedByBb) {
        log(
          `acp bridge: installed Cursor session MCP approval for thread "${bbThreadId}"\n`,
        );
      }
    }

    let sessionId: string | undefined;
    let loadedConfigOptions: readonly AcpConfigOption[] | undefined;
    let loadedModels: AcpSessionModels | undefined;
    let createdFreshSession = false;
    if (request.kind === "fork") {
      const forkedSession = await connection.request({
        method: "session/fork",
        params: {
          sessionId: request.sourceProviderThreadId,
          cwd: params.cwd,
          mcpServers,
        },
        resultSchema: acpSessionForkResultSchema,
        timeoutMs: ACP_SESSION_SETUP_TIMEOUT_MS,
      });
      if (
        forkedSession.sessionId === request.sourceProviderThreadId ||
        getSessionByProviderThreadId(forkedSession.sessionId) !== undefined
      ) {
        throw new Error(
          `ACP agent "${agentLabel}" returned an active session ID for session/fork.`,
        );
      }
      sessionId = forkedSession.sessionId;
      loadedConfigOptions = forkedSession.configOptions;
      loadedModels = forkedSession.models;
      rememberGrokContextWindow(session, forkedSession.models);
    } else if (
      request.kind === "resume" &&
      (capabilities.session.resume || supportsLoadSession)
    ) {
      const restoreMethod = capabilities.session.resume
        ? "session/resume"
        : "session/load";
      session.loading = true;
      session.loadingSessionId = request.resumeProviderThreadId;
      session.pendingLoadUsageUpdate = undefined;
      session.model.beginReplay();
      try {
        const configState = await connection.request({
          method: restoreMethod,
          params: {
            sessionId: request.resumeProviderThreadId,
            cwd: params.cwd,
            mcpServers,
          },
          resultSchema: z.union([acpConfigStateResultSchema, z.null()]),
          timeoutMs: ACP_SESSION_SETUP_TIMEOUT_MS,
        });
        loadedConfigOptions = configState?.configOptions;
        loadedModels = configState?.models;
        rememberGrokContextWindow(session, configState?.models);
        sessionId = request.resumeProviderThreadId;
      } catch (error) {
        if (isAcpAuthRequiredResponse(error)) {
          throw error;
        }
        sessionId = undefined;
        session.loading = false;
        session.loadingSessionId = undefined;
        session.pendingLoadUsageUpdate = undefined;
      } finally {
        session.model.endReplay();
      }
    }

    if (sessionId === undefined) {
      session.loading = false;
      session.loadingSessionId = undefined;
      session.pendingLoadUsageUpdate = undefined;
      const newSession = await connection.request({
        method: "session/new",
        params: { cwd: params.cwd, mcpServers },
        resultSchema: acpSessionNewResultSchema,
        timeoutMs: ACP_SESSION_SETUP_TIMEOUT_MS,
      });
      sessionId = newSession.sessionId;
      createdFreshSession = true;
      rememberGrokContextWindow(session, newSession.models);
      session.nativeConfig = {
        configOptions: newSession.configOptions,
        models: newSession.models,
      };
      await selectAcpNativeModel({
        session,
        sessionId,
        modelSelection: params.modelSelection,
        nativeReasoning: params.nativeReasoning,
      });
      if (request.kind === "resume") {
        emitStartNotification((started) =>
          started.translator.warning({
            summary: `${agentLabel} could not restore the previous session; continuing in a fresh session without in-agent history.`,
          }),
        );
      }
    } else {
      session.nativeConfig = {
        configOptions: loadedConfigOptions,
        models: loadedModels,
      };
      session.pendingInstructions = undefined;
      await selectAcpNativeModel({
        session,
        sessionId,
        modelSelection: params.modelSelection,
        nativeReasoning: params.nativeReasoning,
      });
      const loadUsageUpdate = session.pendingLoadUsageUpdate;
      session.loading = false;
      session.loadingSessionId = undefined;
      session.pendingLoadUsageUpdate = undefined;
      if (loadUsageUpdate) {
        emitStartNotification((started) =>
          emitSessionUpdate(started, loadUsageUpdate, loadUsageUpdate),
        );
      }
    }

    if (session.stopping) {
      throw new Error(
        `ACP session for thread "${bbThreadId}" was released during construction`,
      );
    }
    session.providerThreadId = sessionId;
    bbThreadIdByProviderThreadId.set(sessionId, bbThreadId);
    outputsByBbThreadId.get(bbThreadId)?.identity(sessionId);
    publishSessionSnapshot(session);
    if (createdFreshSession) {
      emitGrokContextWindow(session, 0);
    }
    session.deferStartEmit = undefined;
    for (const deferred of deferredEmits) {
      if (
        deferred.sessionId !== undefined &&
        deferred.sessionId !== sessionId
      ) {
        continue;
      }
      deferred.emit(session);
    }
    deferredEmits.length = 0;
    return session;
  } catch (error) {
    session.stopping = true;
    session.deferStartEmit = undefined;
    await connection.kill();
    removeSession(session);
    await releaseCursorMcpApproval(session);
    throw withAcpSignInGuidance(error, {
      command: params.agent.command,
      args: params.agent.args,
      capabilities: session.capabilities,
    });
  }
}

async function stopSession(session: AcpThreadSession): Promise<void> {
  if (session.stopping) {
    return;
  }
  session.stopping = true;
  dropQueuedTurnInputs(
    session,
    "ACP session stopped before the steer was sent",
  );
  cancelPendingPermissions(session);

  if (session.activePromptKind !== null && !session.connection.exited) {
    session.connection.notify("session/cancel", {
      sessionId: session.providerThreadId,
    });
    if (session.turnSettled) {
      await Promise.race([
        session.turnSettled,
        new Promise<void>((resolveTimeout) =>
          setTimeout(resolveTimeout, THREAD_STOP_CANCEL_TIMEOUT_MS),
        ),
      ]);
    }
  }
  settleInterruptedPrompt(session);

  await session.connection.kill();
  removeSession(session);
  await releaseCursorMcpApproval(session);
}

function settleInterruptedPrompt(session: AcpThreadSession): void {
  switch (session.activePromptKind) {
    case "turn":
      finishTurn(session, "cancelled");
      return;
    case "agent":
      finishAgentTurn(session, "cancelled");
      return;
    case "compaction":
      finishCompaction(session, { status: "interrupted" });
      return;
    case null:
      return;
  }
}

function setActivePromptKind(
  session: AcpThreadSession,
  kind: AcpThreadSession["activePromptKind"],
): void {
  session.activePromptKind = kind;
  if (kind === "turn" || kind === "compaction") {
    clearAgentTurnQuietTimer(session);
    if (!session.promptWorkOpen) {
      session.promptWorkOpen = true;
      session.model.promptSubmitted();
    }
    return;
  }
  if (kind === null) {
    clearAgentTurnQuietTimer(session);
    if (session.promptWorkOpen) {
      session.promptWorkOpen = false;
      session.model.promptSettled({ stopReason: "end_turn" });
    }
    session.model.agentWorkSettled("end_turn");
    session.model.closeUnfinishedToolCalls("cancelled");
  }
}

function clearAgentTurnQuietTimer(session: AcpThreadSession): void {
  if (session.agentTurnQuietTimer !== undefined) {
    clearTimeout(session.agentTurnQuietTimer);
    session.agentTurnQuietTimer = undefined;
  }
}

function agentTurnHasOpenWork(session: AcpThreadSession): boolean {
  return (
    session.pendingPermissions.size > 0 ||
    session.pendingElicitations.size > 0 ||
    session.model.hasUnfinishedToolCalls()
  );
}

function armAgentTurnQuietTimer(session: AcpThreadSession): void {
  clearAgentTurnQuietTimer(session);
  const timer = setTimeout(() => {
    if (session.agentTurnQuietTimer !== timer) {
      return;
    }
    session.agentTurnQuietTimer = undefined;
    if (session.activePromptKind !== "agent" || session.stopping) {
      return;
    }
    if (agentTurnHasOpenWork(session)) {
      armAgentTurnQuietTimer(session);
      return;
    }
    finishAgentTurn(session, "end_turn");
  }, AGENT_TURN_QUIET_MS);
  timer.unref?.();
  session.agentTurnQuietTimer = timer;
}

function openAgentTurn(session: AcpThreadSession): void {
  setActivePromptKind(session, "agent");
  session.translator.turnStarted();
  armAgentTurnQuietTimer(session);
}

function finishAgentTurn(
  session: AcpThreadSession,
  stopReason: "end_turn" | "cancelled",
): void {
  if (session.activePromptKind !== "agent") {
    return;
  }
  for (const controller of session.pendingToolCalls) controller.abort();
  setActivePromptKind(session, null);
  session.translator.turnCompleted(stopReason);
}

function startsAgentWork(events: readonly AcpSessionEvent[]): boolean {
  return events.some(
    (event) =>
      event.type === "work" &&
      event.work.state !== "idle" &&
      event.work.initiator === "agent",
  );
}

function publishThreadState(
  session: AcpThreadSession,
  kind: ExtensionKind,
  payload: JsonValue,
  isEmpty: boolean,
): void {
  if (session.providerThreadId === "" || session.stopping) {
    return;
  }
  const serialized = JSON.stringify(payload);
  const published = session.publishedThreadState.get(kind);
  if (published === serialized || (published === undefined && isEmpty)) {
    return;
  }
  session.publishedThreadState.set(kind, serialized);
  sessionEvents(session.bbThreadId)?.extensionState(kind, payload);
}

async function applySessionOptionSelections(
  session: AcpThreadSession,
  selections: SessionOptionSelections,
): Promise<void> {
  for (const [optionId, value] of Object.entries(selections)) {
    const option = session.model
      .snapshot()
      .configOptions.find((candidate) => candidate.id === optionId);
    if (
      option === undefined ||
      !isUserSelectableSessionOption(option) ||
      option.currentValue === value
    ) {
      continue;
    }
    const offered =
      option.type === "boolean"
        ? typeof value === "boolean"
        : typeof value === "string" &&
          option.values.some((candidate) => candidate.value === value);
    if (!offered) {
      continue;
    }
    let result: unknown;
    try {
      if (option.setMethod === "session/set_mode") {
        await session.connection.request({
          method: "session/set_mode",
          params: { sessionId: session.providerThreadId, modeId: value },
          resultSchema: z.unknown(),
          timeoutMs: ACP_SESSION_CONFIG_TIMEOUT_MS,
        });
      } else {
        result = await session.connection.request({
          method: "session/set_config_option",
          params: {
            sessionId: session.providerThreadId,
            configId: option.id,
            ...(option.type === "boolean" ? { type: "boolean" } : {}),
            value,
          },
          resultSchema: z.unknown(),
          timeoutMs: ACP_SESSION_CONFIG_TIMEOUT_MS,
        });
      }
    } catch (error) {
      session.translator.warning({
        summary: `The agent did not apply ${option.name.trim() === "" ? option.id : option.name}`,
        details: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!isJsonObject(result) || !("configOptions" in result)) {
      publishSessionStateEvents(
        session,
        session.model.applyConfigOptionValue(optionId, value),
      );
    }
  }
}

function publishSessionSnapshot(session: AcpThreadSession): void {
  const snapshot = session.model.snapshot();
  const commands = toThreadProviderCommandsState(snapshot.commands);
  publishThreadState(
    session,
    THREAD_PROVIDER_COMMANDS_STATE_KIND,
    commands,
    commands.commands.length === 0,
  );
  const options = toThreadSessionOptionsState(snapshot.configOptions);
  publishThreadState(
    session,
    THREAD_SESSION_OPTIONS_STATE_KIND,
    options,
    options.options.length === 0,
  );
}

function publishSessionStateEvents(
  session: AcpThreadSession,
  events: readonly AcpSessionEvent[],
): void {
  if (
    events.some(
      (event) => event.type === "commands" || event.type === "configOptions",
    )
  ) {
    publishSessionSnapshot(session);
  }
}

function noteAgentResponse(
  session: AcpThreadSession,
  method: string,
  result: unknown,
): void {
  if (!isJsonObject(result)) {
    return;
  }
  switch (method) {
    case "session/new":
    case "session/load":
    case "session/resume":
    case "session/fork":
      publishSessionStateEvents(
        session,
        session.model.applySessionSetup(result),
      );
      return;
    case "session/set_config_option":
    case "session/set_model":
      if ("configOptions" in result) {
        publishSessionStateEvents(
          session,
          session.model.applyConfigOptions(result["configOptions"]),
        );
      }
      return;
  }
}

function emitSessionUpdate(
  session: AcpThreadSession,
  update: unknown,
  rawUpdate: unknown,
): void {
  const turnOutput = isTurnOutputUpdate(update);
  if (
    turnOutput &&
    session.awaitingFirstPrompt &&
    session.activePromptKind === null
  ) {
    return;
  }
  const events = session.model.applySessionUpdate(rawUpdate);
  publishSessionStateEvents(session, events);
  session.agentUpdateCount += 1;
  if (turnOutput) {
    session.turnOutputCount += 1;
  }
  if (session.activePromptKind === null && startsAgentWork(events)) {
    openAgentTurn(session);
  } else if (session.activePromptKind === "agent") {
    armAgentTurnQuietTimer(session);
  }
  const parsedUpdate = acpSessionUpdateSchema.safeParse(update);
  if (parsedUpdate.success) {
    session.translator.update(parsedUpdate.data);
  }
}

async function releaseSession(session: AcpThreadSession): Promise<void> {
  if (session.stopping) {
    return;
  }
  session.stopping = true;
  clearAgentTurnQuietTimer(session);
  dropQueuedTurnInputs(
    session,
    "ACP session released before the steer was sent",
  );
  cancelPendingPermissions(session);
  await session.connection.kill();
  removeSession(session);
  await releaseCursorMcpApproval(session);
}

function requestSteerCancel(session: AcpThreadSession): void {
  if (
    session.stopping ||
    session.cancelRequested ||
    !session.promptRequestPending ||
    session.connection.exited
  ) {
    return;
  }
  session.cancelRequested = true;
  cancelPendingPermissions(session);
  session.connection.notify("session/cancel", {
    sessionId: session.providerThreadId,
  });
}

function acceptTurnInput(
  session: AcpThreadSession,
  pending: AcpPendingTurnInput,
): void {
  session.translator.inputAccepted(pending.clientRequestId);
  takeTurnInputSettlement(pending)?.resolve();
}

function dropTurnInput(pending: AcpPendingTurnInput, reason: string): void {
  takeTurnInputSettlement(pending)?.reject(new RunnerError("failed", reason));
}

function takeTurnInputSettlement(
  pending: AcpPendingTurnInput,
): TurnInputSettlement | null {
  const settlement = pending.settlement;
  pending.settlement = null;
  return settlement;
}

function dropQueuedTurnInputs(session: AcpThreadSession, reason: string): void {
  for (const pending of session.queuedInputs.splice(0)) {
    dropTurnInput(pending, reason);
  }
}

function finishTurn(
  session: AcpThreadSession,
  stopReason: z.infer<typeof acpStopReasonSchema>,
): void {
  if (session.activePromptKind !== "turn") {
    return;
  }
  for (const controller of session.pendingToolCalls) controller.abort();
  setActivePromptKind(session, null);
  dropQueuedTurnInputs(session, "ACP turn ended before the steer was sent");
  session.promptRequestPending = false;
  session.cancelRequested = false;
  session.translator.turnCompleted(stopReason);
}

function isSessionBusyError(error: unknown): boolean {
  return (
    error instanceof AcpAgentResponseError &&
    error.code === ACP_SESSION_BUSY_ERROR_CODE &&
    isJsonObject(error.data) &&
    error.data["reason"] === "session_busy"
  );
}

async function waitForAgentQuiet(session: AcpThreadSession): Promise<boolean> {
  for (let waits = 0; waits < SESSION_BUSY_MAX_WAITS; waits += 1) {
    const updatesBefore = session.agentUpdateCount;
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, SESSION_BUSY_QUIET_MS);
    });
    if (
      session.stopping ||
      session.connection.exited ||
      session.cancelRequested
    ) {
      return false;
    }
    if (
      session.agentUpdateCount === updatesBefore &&
      !session.model.hasUnfinishedToolCalls()
    ) {
      return true;
    }
  }
  return false;
}

const TURN_OUTPUT_UPDATE_KINDS = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

function isTurnOutputUpdate(update: unknown): boolean {
  const kind = isJsonObject(update) ? update["sessionUpdate"] : undefined;
  return typeof kind === "string" && TURN_OUTPUT_UPDATE_KINDS.has(kind);
}

function runTurn(
  session: AcpThreadSession,
  firstInput: AcpPendingTurnInput,
  turnAlreadyOpen = false,
): void {
  setActivePromptKind(session, "turn");
  if (!turnAlreadyOpen) {
    session.translator.turnStarted();
  }
  session.awaitingFirstPrompt = false;
  const outputBeforeTurn = session.turnOutputCount;

  session.turnSettled = (async () => {
    let pending = firstInput;
    for (;;) {
      if (session.stopping) {
        dropTurnInput(pending, "ACP session is stopping");
        finishTurn(session, "cancelled");
        return;
      }

      let stopReason: z.infer<typeof acpStopReasonSchema>;
      session.cancelRequested = false;
      try {
        const previousSession = session;
        const reconciled = reconcileExecutionSettings(session, pending.options);
        session = reconciled instanceof Promise ? await reconciled : reconciled;
        if (session.stopping) {
          dropTurnInput(pending, "ACP session is stopping");
          finishTurn(session, "cancelled");
          return;
        }
        setActivePromptKind(session, "turn");
        session.turnSettled = previousSession.turnSettled;
        if (session !== previousSession) {
          session.translator.turnStarted();
          session.awaitingFirstPrompt = false;
        }
        const prompt = buildPromptContentBlocks(session, pending.input);
        let inputAccepted = false;
        let busyRetries = 0;
        for (;;) {
          session.promptRequestPending = true;
          const promptResult = session.connection.request({
            method: "session/prompt",
            params: { sessionId: session.providerThreadId, prompt },
            resultSchema: acpPromptResultSchema,
          });
          if (!inputAccepted) {
            inputAccepted = true;
            acceptTurnInput(session, pending);
          }
          if (session.queuedInputs.length > 0) {
            requestSteerCancel(session);
          }
          try {
            const result = await promptResult;
            stopReason = result.stopReason;
            const grokUsage = grokContextUsageFromPromptResult(result);
            if (grokUsage !== undefined) {
              emitGrokContextWindow(session, grokUsage.used);
            }
            break;
          } catch (error) {
            if (
              !isSessionBusyError(error) ||
              busyRetries >= SESSION_BUSY_MAX_RETRIES ||
              session.stopping ||
              session.cancelRequested
            ) {
              throw error;
            }
            busyRetries += 1;
            session.promptRequestPending = false;
            if (!(await waitForAgentQuiet(session))) {
              throw error;
            }
          }
        }
      } catch (error) {
        session.restartAfterCancelError = session.cancelRequested;
        session.promptRequestPending = false;
        dropTurnInput(pending, "ACP turn failed before the prompt was sent");
        dropQueuedTurnInputs(
          session,
          "ACP turn failed before the steer was sent",
        );
        session.cancelRequested = false;
        if (!session.stopping) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (!session.connection.exited) {
            emitSessionError(session, message);
          } else if (session.activePromptKind === "turn") {
            session.translator.failed(message);
          }
        }
        setActivePromptKind(session, null);
        return;
      }
      session.promptRequestPending = false;

      if (!session.stopping) {
        const next = session.queuedInputs.shift();
        if (next) {
          pending = next;
          continue;
        }
      }

      if (
        stopReason === "end_turn" &&
        !session.stopping &&
        session.turnOutputCount === outputBeforeTurn
      ) {
        session.translator.warning({
          summary: "The agent ended the turn without replying",
          details:
            "The agent reported no error and sent nothing back. If this keeps happening, check that the agent runs and is signed in on the machine that hosts the thread.",
        });
      }
      finishTurn(session, stopReason);
      return;
    }
  })();
}

function reconcileExecutionSettings(
  session: AcpThreadSession,
  options: BridgeExecutionOptions,
): AcpThreadSession | Promise<AcpThreadSession> {
  if (options.permissionMode === "auto") {
    throw new Error('ACP does not support permission mode "auto".');
  }
  const launchSpec = decodeLaunchSpec(options.providerOptions);
  const envVars =
    Object.keys(options.envVars ?? {}).length > 0
      ? {
          ...(launchSpec?.env ?? {}),
          ...options.envVars,
        }
      : session.construction.envVars;
  const workspaceWriteRoots =
    options.providerOptions?.additionalWorkspaceWriteRoots !== undefined
      ? [
          session.cwd,
          ...decodeAdditionalWorkspaceWriteRoots(options.providerOptions),
        ]
      : session.policy.workspaceWriteRoots;
  const modelParams =
    launchSpec === null
      ? session.construction
      : buildAcpModelSelectionParams(
          launchSpec,
          options,
          decodeAcpModelPickerOptions(options.providerOptions)
            .parameterizedModelPicker,
          decodeDialectId(options.providerOptions),
        );
  const construction: AcpSessionParams = {
    ...session.construction,
    modelSelection: modelParams.modelSelection,
    launchReasoningLevel: modelParams.launchReasoningLevel,
    envVars,
    permissionMode: options.permissionMode,
    workspaceWriteRoots,
  };
  const launchArgsChanged =
    !isDeepStrictEqual(
      permissionCliArgsForMode(
        session.construction.permissionCli,
        session.construction.permissionMode,
      ),
      permissionCliArgsForMode(
        construction.permissionCli,
        construction.permissionMode,
      ),
    ) ||
    !isDeepStrictEqual(
      launchModelSelection(session.construction),
      launchModelSelection(construction),
    );
  const restart =
    session.connection.exited ||
    session.restartAfterCancelError ||
    launchArgsChanged ||
    !isDeepStrictEqual(envVars ?? {}, session.construction.envVars ?? {});
  cancelPendingPermissions(session);
  session.policy = {
    permissionMode: options.permissionMode,
    workspaceWriteRoots,
  };
  if (restart) {
    return rebuildAgentSession(session, construction);
  }
  if (
    isDeepStrictEqual(
      construction.modelSelection,
      session.construction.modelSelection,
    ) &&
    !acpNativeModelDrifted(session.nativeConfig, construction.modelSelection)
  ) {
    session.construction = construction;
    return session;
  }
  return applyNativeModelSelection(session, construction);
}

function launchModelSelection(params: AcpSessionParams): {
  modelSelection: AcpSessionParams["modelSelection"];
  launchReasoningLevel: AcpSessionParams["launchReasoningLevel"];
} {
  return {
    modelSelection:
      params.modelSelection && "selectFlag" in params.modelSelection
        ? params.modelSelection
        : undefined,
    launchReasoningLevel: params.launchReasoningLevel,
  };
}

async function applyNativeModelSelection(
  session: AcpThreadSession,
  construction: AcpSessionParams,
): Promise<AcpThreadSession> {
  await selectAcpNativeModel({
    session,
    sessionId: session.providerThreadId,
    modelSelection: construction.modelSelection,
    nativeReasoning: construction.nativeReasoning,
  });
  session.construction = construction;
  return session;
}

async function rebuildAgentSession(
  session: AcpThreadSession,
  construction: AcpSessionParams,
): Promise<AcpThreadSession> {
  const previousProviderThreadId = session.providerThreadId;
  const reason = session.connection.exited
    ? "The ACP agent exited unexpectedly; its session was rebuilt before continuing."
    : session.restartAfterCancelError
      ? "The ACP agent failed during cancellation; its session was rebuilt before continuing."
      : "Execution settings changed; the ACP session was rebuilt to apply them.";
  const queuedInputs = session.queuedInputs.splice(0);
  const continuingTurn = session.activePromptKind === "turn";
  finishTurn(session, "cancelled");
  let replacement: AcpThreadSession;
  try {
    replacement = await startAgentSession({
      kind: "resume",
      params: construction,
      resumeProviderThreadId: previousProviderThreadId,
    });
  } catch (error) {
    if (continuingTurn) {
      emitSessionError(
        session,
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
  replacement.queuedInputs.push(...queuedInputs);
  if (replacement.providerThreadId !== previousProviderThreadId) {
    replacement.translator.warning({
      summary: reason,
    });
  }
  outputsByBbThreadId
    .get(session.bbThreadId)
    ?.replaced(replacement.providerThreadId);
  return replacement;
}

function startCompaction(
  session: AcpThreadSession,
  pending: AcpPendingTurnInput,
): void {
  setActivePromptKind(session, "compaction");
  session.awaitingFirstPrompt = false;
  session.compactionAgentMessage = "";
  session.translator.compactionStarted();

  const finish = (outcome: AcpCompactionOutcome): void => {
    finishCompaction(session, outcome);
  };

  const promptResult = session.connection.request({
    method: "session/prompt",
    params: {
      sessionId: session.providerThreadId,
      prompt: [{ type: "text", text: "/compact" }],
    },
    resultSchema: acpPromptResultSchema,
  });
  acceptTurnInput(session, pending);

  session.turnSettled = promptResult
    .then((result) => {
      const grokUsage = grokContextUsageFromPromptResult(result);
      if (grokUsage !== undefined) {
        emitGrokContextWindow(session, grokUsage.used);
      }
      finish(
        result.stopReason === "end_turn"
          ? compactionOutcomeForEndTurn(
              session.dialect,
              session.compactionAgentMessage,
            )
          : result.stopReason === "cancelled"
            ? { status: "interrupted" }
            : {
                status: "failed",
                error: `Agent stopped compaction: ${result.stopReason}`,
              },
      );
    })
    .catch((error: unknown) => {
      finish({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

function finishCompaction(
  session: AcpThreadSession,
  outcome: AcpCompactionOutcome,
): void {
  if (session.activePromptKind !== "compaction") {
    return;
  }
  session.translator.compactionCompleted(outcome);
  setActivePromptKind(session, null);
  session.turnSettled = undefined;
}

function handleAgentRequest(
  session: AcpThreadSession,
  method: string,
  params: unknown,
  responder: AcpAgentRequestResponder,
): void {
  switch (method) {
    case "session/request_permission":
      handlePermissionRequest(session, params, responder);
      return;
    case "fs/read_text_file":
      void handleFsReadTextFile(params, responder);
      return;
    case "fs/write_text_file":
      void handleFsWriteTextFile(session, params, responder);
      return;
    case "elicitation/create":
      handleElicitationRequest(session, params, responder);
      return;
    default:
      handleDialectRequest(session, method, params, responder);
  }
}

function handleDialectRequest(
  session: AcpThreadSession,
  method: string,
  params: unknown,
  responder: AcpAgentRequestResponder,
): void {
  const outcome = session.dialect.handleClientRequest?.(method, params);
  if (outcome === undefined) {
    responder.error(-32601, `Unsupported ACP client method "${method}"`);
    return;
  }
  if (outcome.delegation !== undefined) {
    session.translator.noteDelegationReport(
      session.bbThreadId,
      outcome.delegation,
    );
  }
  responder.result(outcome.result);
}

function handleAgentNotification(
  session: AcpThreadSession,
  method: string,
  params: unknown,
): void {
  if (method !== "session/update") {
    return;
  }
  if (session.stopping) {
    return;
  }
  const parsed = acpSessionNotificationParamsSchema.safeParse(params);
  if (!parsed.success) {
    return;
  }
  const rawUpdate = isJsonObject(params) ? params["update"] : undefined;
  if (session.loading) {
    if (parsed.data.sessionId === session.loadingSessionId) {
      session.model.applySessionUpdate(rawUpdate);
      if (parsed.data.update.sessionUpdate === "usage_update") {
        const usageUpdate = acpUsageUpdateSchema.safeParse(parsed.data.update);
        if (usageUpdate.success) {
          session.pendingLoadUsageUpdate = usageUpdate.data;
        }
      }
    }
    return;
  }
  if (session.providerThreadId === "") {
    const { update } = parsed.data;
    session.deferStartEmit?.(
      (started) => emitSessionUpdate(started, update, rawUpdate ?? update),
      parsed.data.sessionId,
    );
    return;
  }
  if (parsed.data.sessionId !== session.providerThreadId) {
    return;
  }
  if (parsed.data.update.sessionUpdate === "config_option_update") {
    const configState = acpConfigStateResultSchema.safeParse(
      parsed.data.update,
    );
    if (configState.success && configState.data.configOptions) {
      session.nativeConfig = {
        ...session.nativeConfig,
        configOptions: configState.data.configOptions,
      };
    }
  }
  if (session.activePromptKind === "compaction") {
    const chunk = acpAgentMessageChunkUpdateSchema.safeParse(
      parsed.data.update,
    );
    if (chunk.success) {
      session.compactionAgentMessage +=
        extractAcpContentText(chunk.data.content) ?? "";
    }
  }
  emitSessionUpdate(session, parsed.data.update, rawUpdate);
}

function decodeLaunchSpec(
  providerOptions: Record<string, unknown> | undefined,
): AcpLaunchSpec | null {
  const launchSpec = acpLaunchSpecSchema.safeParse(
    providerOptions?.["acpLaunchSpec"],
  );
  return launchSpec.success ? launchSpec.data : null;
}

const acpProviderOptionsSchema = z
  .object({
    additionalWorkspaceWriteRoots: z.array(z.string()).optional(),
    acpDialect: z.string().min(1).optional(),
    parameterizedModelPicker: z.boolean().optional(),
    primaryModels: z.array(z.string().min(1)).optional(),
    reasoningProbePriorityModelIds: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

interface AcpModelPickerOptions {
  parameterizedModelPicker: boolean;
  primaryModels?: string[];
  reasoningProbePriorityModelIds: string[];
}

function decodeAcpModelPickerOptions(
  providerOptions: Record<string, unknown> | undefined,
): AcpModelPickerOptions {
  const parsed = acpProviderOptionsSchema.parse(providerOptions ?? {});
  return {
    parameterizedModelPicker: parsed.parameterizedModelPicker === true,
    ...(parsed.primaryModels === undefined
      ? {}
      : { primaryModels: [...parsed.primaryModels] }),
    reasoningProbePriorityModelIds: [
      ...(parsed.reasoningProbePriorityModelIds ?? []),
    ],
  };
}

function decodeAdditionalWorkspaceWriteRoots(
  providerOptions: Record<string, unknown> | undefined,
): string[] {
  return (
    acpProviderOptionsSchema.parse(providerOptions ?? {})
      .additionalWorkspaceWriteRoots ?? []
  );
}

function decodeDialectId(
  providerOptions: Record<string, unknown> | undefined,
): string | undefined {
  return acpProviderOptionsSchema.parse(providerOptions ?? {}).acpDialect;
}

function maintenanceTarget(
  providerOptions: Record<string, unknown> | undefined,
): {
  maintenance: AcpMaintenanceDialect | undefined;
  command: string | null;
  dialectId: string;
  env: NodeJS.ProcessEnv;
} {
  const launchSpec = decodeLaunchSpec(providerOptions);
  const dialect = resolveAcpDialect({
    dialectId: decodeDialectId(providerOptions),
    command: launchSpec?.command ?? "",
  });
  return {
    maintenance: dialect.maintenance,
    command: launchSpec?.command ?? null,
    dialectId: dialect.id,
    env: { ...process.env, ...launchSpec?.env },
  };
}

export type AcpProviderOptions = Record<string, unknown>;

export function setAcpToolProxyDirectory(directory: string): void {
  mcpScriptDirectory = directory;
}

export async function listAcpModels(
  providerOptions: AcpProviderOptions,
): Promise<{ models: AvailableModel[]; selectedOnlyModels: AvailableModel[] }> {
  const params = buildAcpModelListParams(
    decodeLaunchSpec(providerOptions),
    decodeAcpModelPickerOptions(providerOptions),
  );
  const dialectId = decodeDialectId(providerOptions);
  const reasoning = {
    reasoningCli: params.reasoningCli,
    nativeReasoning: params.nativeReasoning,
  };
  const split = (models: readonly AvailableModel[]) =>
    splitPrimaryModels(
      applyConfiguredReasoningToModels(models, reasoning),
      params.primaryModels,
    );
  const catalog = params.listCommand
    ? await loadAgentModelCatalog(params.listCommand)
    : null;
  if (catalog) {
    return split(
      params.parameterizedModelPicker && dialectId === "cursor"
        ? buildCursorParameterizedModelCatalog(catalog.models)
        : catalog.models,
    );
  }
  const discovered =
    params.listCommand === undefined && params.agent
      ? await loadSessionDiscoveredModels(
          params.agent,
          params.reasoningProbePriorityModelIds,
          params.parameterizedModelPicker,
        )
      : null;
  if (discovered) {
    return split(discovered);
  }
  return {
    models: [applyConfiguredReasoningToModel(ACP_DEFAULT_MODEL, reasoning)],
    selectedOnlyModels: [],
  };
}

export async function listAcpSessionOptions(
  providerOptions: AcpProviderOptions,
): Promise<ThreadSessionOption[]> {
  const params = buildAcpModelListParams(
    decodeLaunchSpec(providerOptions),
    decodeAcpModelPickerOptions(providerOptions),
  );
  return params.optionsAgent
    ? loadDeclaredSessionOptions(
        params.optionsAgent,
        params.parameterizedModelPicker,
      )
    : [];
}

export function acpProviderHealth(
  providerOptions: AcpProviderOptions,
  provider: Omit<AcpStatusTarget, "maintenance" | "command">,
) {
  return getAcpProviderStatus({
    ...provider,
    ...maintenanceTarget(providerOptions),
  });
}

export function acpProviderUsage(providerOptions: AcpProviderOptions) {
  return getAcpProviderUsage(maintenanceTarget(providerOptions));
}

export interface AcpOpenRequest {
  threadId: string;
  cwd: string;
  dynamicTools: readonly DynamicTool[];
  instructions: string;
  skillRoots: readonly AcpSkillRoot[];
  options: AcpExecutionOptions;
  output: AcpSessionOutput;
  resumeProviderThreadId?: string | undefined;
  forkProviderThreadId?: string | undefined;
}

export interface AcpOpenedSession {
  providerThreadId: string;
  restorable: boolean;
}

export async function openAcpSession(
  request: AcpOpenRequest,
): Promise<AcpOpenedSession> {
  const { options, threadId } = request;
  const launchSpec = decodeLaunchSpec(options.providerOptions);
  if (launchSpec === null) {
    throw new RunnerError("failed", "This ACP agent has no launch command.");
  }
  const sessionParams = buildAcpSessionParams({
    additionalWorkspaceWriteRoots: decodeAdditionalWorkspaceWriteRoots(
      options.providerOptions,
    ),
    dialectId: decodeDialectId(options.providerOptions),
    cwd: request.cwd,
    dynamicTools: request.dynamicTools,
    options: {
      ...options,
      instructions: request.instructions,
      skillRoots: request.skillRoots,
    },
    parameterizedModelPicker: decodeAcpModelPickerOptions(
      options.providerOptions,
    ).parameterizedModelPicker,
    launchSpec,
    providerLabel: launchSpec.displayName,
    threadId,
  });
  outputsByBbThreadId.set(threadId, request.output);
  try {
    const session = await startAgentSession(
      request.forkProviderThreadId !== undefined
        ? {
            kind: "fork",
            params: sessionParams,
            sourceProviderThreadId: request.forkProviderThreadId,
          }
        : request.resumeProviderThreadId !== undefined
          ? {
              kind: "resume",
              params: sessionParams,
              resumeProviderThreadId: request.resumeProviderThreadId,
            }
          : { kind: "start", params: sessionParams },
    );
    return {
      providerThreadId: session.providerThreadId,
      restorable: session.supportsLoadSession,
    };
  } catch (error) {
    if (outputsByBbThreadId.get(threadId) === request.output) {
      outputsByBbThreadId.delete(threadId);
    }
    throw withAcpAuthRequiredRecovery(error);
  }
}

export function acpSessionIsLive(threadId: string): boolean {
  const session = liveSessionForThread(threadId);
  return session !== undefined && !session.connection.exited;
}

export interface AcpTurnRequest {
  clientRequestId: string;
  input: PromptInput[];
  options: AcpExecutionOptions;
}

export async function startAcpTurn(
  threadId: string,
  request: AcpTurnRequest,
): Promise<void> {
  let session = liveSessionForThread(threadId);
  if (session === undefined) {
    throw new RunnerError("session_not_found", "No active ACP session");
  }
  if (session.activePromptKind === "agent") {
    finishAgentTurn(
      session,
      agentTurnHasOpenWork(session) ? "cancelled" : "end_turn",
    );
  }
  if (session.activePromptKind !== null) {
    throw new RunnerError("competing_turn", "A turn is already active");
  }
  try {
    const reconciled = reconcileExecutionSettings(session, request.options);
    session = reconciled instanceof Promise ? await reconciled : reconciled;
    if (request.options.sessionOptions !== undefined) {
      await applySessionOptionSelections(
        session,
        request.options.sessionOptions,
      );
    }
  } catch (error) {
    throw withAcpAuthRequiredRecovery(error);
  }
  const live = session;
  await new Promise<void>((resolveAccepted, rejectAccepted) => {
    const pending: AcpPendingTurnInput = {
      clientRequestId: request.clientRequestId,
      input: request.input,
      settlement: { resolve: resolveAccepted, reject: rejectAccepted },
      options: request.options,
    };
    if (isStandaloneBuiltinCompactCommand(request.input)) {
      startCompaction(live, pending);
    } else {
      runTurn(live, pending);
    }
  });
}

export function steerAcpTurn(
  threadId: string,
  request: AcpTurnRequest,
): "steered" | "stale" {
  const session = liveSessionForThread(threadId);
  if (session === undefined) {
    return "stale";
  }
  const pending: AcpPendingTurnInput = { ...request, settlement: null };
  if (session.activePromptKind === "agent") {
    runTurn(session, pending, true);
    return "steered";
  }
  if (session.activePromptKind !== "turn") {
    return "stale";
  }
  session.queuedInputs.push(pending);
  requestSteerCancel(session);
  return "steered";
}

export async function stopAcpSession(
  threadId: string,
  intent: "stop" | "release",
): Promise<void> {
  const session = sessionsByBbThreadId.get(threadId);
  if (session) {
    await (intent === "release"
      ? releaseSession(session)
      : stopSession(session));
  }
  if (intent === "release") {
    outputsByBbThreadId.delete(threadId);
  }
}

export async function closeAcpToolProxy(): Promise<void> {
  const bridge = dynamicToolBridgePromise
    ? await dynamicToolBridgePromise.catch(() => null)
    : null;
  dynamicToolBridgePromise = null;
  await new Promise<void>((resolveClose) => {
    if (!bridge) {
      resolveClose();
      return;
    }
    bridge.server.close(() => resolveClose());
  });
}
