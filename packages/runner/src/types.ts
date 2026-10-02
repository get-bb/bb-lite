import type {
  AvailableModel,
  DynamicTool,
  PendingInteractionPayload,
  PendingInteractionResolution,
  PermissionEscalation,
  PermissionMode,
  PromptInput,
  ReasoningLevel,
  ServiceTier,
  ThreadEvent,
  ToolCallResponse,
} from "@bb/domain";

export type ProviderId = "codex" | "claude-code" | "echo";

export const SERVER_URL_PLACEHOLDER = "{BB_SERVER_URL}";

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type RunnerThreadEvent = DistributiveOmit<ThreadEvent, "threadId">;

export interface ExecutionOptions {
  model: string;
  reasoningLevel: ReasoningLevel;
  serviceTier: ServiceTier;
  permissionMode: PermissionMode;
  permissionEscalation: PermissionEscalation;
  providerOptions: Record<string, unknown>;
}

export interface SessionSpec {
  threadId: string;
  providerId: ProviderId;
  cwd: string;
  providerThreadId: string | null;
  instructions: string;
  dynamicTools: DynamicTool[];
  env: Record<string, string>;
  skillDirs: string[];
}

export type SubmitTurnMode =
  | { kind: "start" }
  | { kind: "steer"; expectedTurnId: string }
  | { kind: "auto" };

export interface SubmitTurnArgs {
  session: SessionSpec;
  clientRequestId: string;
  input: PromptInput[];
  options: ExecutionOptions;
  mode: SubmitTurnMode;
}

export type SubmitTurnResult =
  | { outcome: "started"; providerThreadId: string }
  | { outcome: "steered"; providerThreadId: string; turnId: string };

export interface RunnerInfo {
  instanceId: string;
  version: string;
  hostName: string;
  platform: "darwin" | "linux" | "win32";
  homeDir: string;
  dataDir: string;
  threadStorageRoot: string;
}

export interface RunnerSnapshot {
  sessions: {
    threadId: string;
    providerId: ProviderId;
    providerThreadId: string;
    activeTurnId: string | null;
  }[];
  pendingRequestIds: string[];
  terminalIds: string[];
  lastEventSeq: number;
}

export interface ProviderStatus {
  providerId: ProviderId;
  installed: boolean;
  executablePath: string | null;
  version: string | null;
  auth: "ready" | "unauthenticated" | "unknown";
  message: string | null;
}

export interface ProviderModels {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
}

export const RUNNER_ERROR_CODES = [
  "competing_turn",
  "stale_turn",
  "session_not_found",
  "missing_executable",
  "auth_required",
  "rate_limited",
  "path_not_found",
  "not_git_repo",
  "permission_denied",
  "invalid_path",
  "file_too_large",
  "conflict",
  "no_changes",
  "terminal_not_found",
  "unavailable",
  "failed",
] as const;

export type RunnerErrorCode = (typeof RUNNER_ERROR_CODES)[number];

export class RunnerError extends Error {
  readonly code: RunnerErrorCode;
  readonly retryable: boolean;
  constructor(code: RunnerErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
    this.retryable = retryable;
  }
}

type Reliable<Body> = { lane: "reliable"; seq: number } & Body;
type Live<Body> = { lane: "live" } & Body;

export type RunnerEvent =
  | Reliable<{
      kind: "thread.events";
      threadId: string;
      events: RunnerThreadEvent[];
    }>
  | Reliable<{
      kind: "interaction.requested";
      threadId: string;
      turnId: string | null;
      requestId: string;
      providerId: ProviderId;
      providerThreadId: string;
      payload: PendingInteractionPayload;
    }>
  | Reliable<{
      kind: "interaction.cancelled";
      threadId: string;
      requestId: string;
      reason: string;
    }>
  | Reliable<{
      kind: "toolCall.requested";
      threadId: string;
      turnId: string | null;
      requestId: string;
      callId: string;
      tool: string;
      arguments: unknown;
    }>
  | Reliable<{
      kind: "toolCall.cancelled";
      threadId: string;
      requestId: string;
    }>
  | Reliable<{
      kind: "script.output";
      operationId: string;
      text: string;
    }>
  | Live<{
      kind: "terminal.output";
      terminalId: string;
      seq: number;
      dataBase64: string;
    }>
  | Live<{
      kind: "terminal.exited";
      terminalId: string;
      exitCode: number | null;
    }>
  | Live<{
      kind: "workspace.changed";
      path: string;
      change: "status" | "refs" | "files";
    }>;

export type RunnerEventSink = (event: RunnerEvent) => void;

export interface SessionApi {
  describe(): Promise<RunnerInfo>;
  snapshot(): Promise<RunnerSnapshot>;
  ackEvents(args: { seq: number }): Promise<void>;
  listProviders(): Promise<ProviderStatus[]>;
  listModels(args: {
    providerId: ProviderId;
    cwd: string | null;
  }): Promise<ProviderModels>;
  submitTurn(args: SubmitTurnArgs): Promise<SubmitTurnResult>;
  interruptTurn(args: { threadId: string }): Promise<{ interrupted: boolean }>;
  releaseSession(args: { threadId: string }): Promise<void>;
  resolveInteraction(args: {
    threadId: string;
    requestId: string;
    resolution: PendingInteractionResolution;
  }): Promise<{ delivered: boolean }>;
  resolveToolCall(args: {
    threadId: string;
    requestId: string;
    result: ToolCallResponse;
  }): Promise<{ delivered: boolean }>;
  renameSession(args: { threadId: string; title: string }): Promise<void>;
  deleteThreadStorage(args: { threadId: string }): Promise<void>;
}
