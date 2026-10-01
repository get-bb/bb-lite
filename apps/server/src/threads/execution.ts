import {
  clampPermissionModeToCeiling,
  promptInputHasCommandMention,
  type CallerExecutionInputSource,
  type PermissionMode,
  type ProjectExecutionDefaults,
  type PromptInput,
  type ReasoningLevel,
  type ResolvedThreadExecutionOptions,
  type ServiceTier,
  type ThreadTurnInitiator,
} from "@bb/domain";
import type { ExecutionOptions, ProviderId } from "@bb/runner";
import {
  getEnvironmentRow,
  getHostRow,
  readProjectExecutionDefaults,
} from "../db/engine-lookups.js";
import type { Db } from "../db/index.js";
import { getAppSettings } from "../db/settings.js";
import { getThread, type ThreadPatch, type ThreadRow } from "../db/threads.js";
import { ApiError, invalidRequest } from "../http/errors.js";
import type { EngineContext } from "./core.js";

export interface ExecutionTuple {
  model: string;
  reasoningLevel: ReasoningLevel;
  permissionMode: PermissionMode;
  serviceTier: ServiceTier;
}

type ExecutionField = keyof ExecutionTuple;

export interface ExecutionRequest extends Partial<ExecutionTuple> {
  executionInputSources?: Partial<
    Record<ExecutionField, CallerExecutionInputSource>
  >;
}

interface CreateExecutionArgs {
  request: ExecutionRequest & { providerId?: string };
  projectId: string;
  hostId: string;
  parent: ThreadRow | null;
}

const PROVIDER_IDS: readonly ProviderId[] = ["codex", "claude-code", "echo"];
const DEFAULT_REASONING_LEVEL: ReasoningLevel = "medium";
const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

export function requireProviderId(value: string): ProviderId {
  const known = PROVIDER_IDS.find((providerId) => providerId === value);
  if (known !== undefined) return known;
  const names = PROVIDER_IDS.join(", ");
  throw invalidRequest(`Unknown provider "${value}". Use ${names}.`);
}

function namedFields(request: ExecutionRequest): Partial<ExecutionTuple> {
  const sources = request.executionInputSources;
  const named = (field: ExecutionField): boolean =>
    sources === undefined || sources[field] !== undefined;
  const { model, reasoningLevel, permissionMode, serviceTier } = request;
  return {
    ...(named("model") && model ? { model } : {}),
    ...(named("reasoningLevel") && reasoningLevel ? { reasoningLevel } : {}),
    ...(named("permissionMode") && permissionMode ? { permissionMode } : {}),
    ...(named("serviceTier") && serviceTier ? { serviceTier } : {}),
  };
}

function isExplicit(request: ExecutionRequest, field: ExecutionField): boolean {
  const sources = request.executionInputSources;
  return sources === undefined || sources[field] === "explicit";
}

export function stickyOverrides(request: ExecutionRequest): ThreadPatch {
  const { model, reasoningLevel } = namedFields(request);
  const patch: ThreadPatch = {};
  if (model !== undefined && isExplicit(request, "model")) {
    patch.modelOverride = model;
  }
  if (reasoningLevel !== undefined && isExplicit(request, "reasoningLevel")) {
    patch.reasoningLevelOverride = reasoningLevel;
  }
  return patch;
}

function clampToHost(
  db: Db,
  hostId: string | null,
  permissionMode: PermissionMode,
): PermissionMode {
  const ceiling = hostId === null ? undefined : getHostRow(db, hostId);
  if (ceiling === undefined) return permissionMode;
  const clamped = clampPermissionModeToCeiling({
    ceiling: ceiling.maxPermissionMode,
    permissionMode,
  });
  return clamped ?? permissionMode;
}

function serviceTierFor(
  db: Db,
  candidates: (ServiceTier | null | undefined)[],
): ServiceTier {
  if (!getAppSettings(db).allowFastServiceTier) return "default";
  return candidates.find((tier) => tier != null) ?? "default";
}

function liveParentOf(db: Db, thread: ThreadRow): ThreadRow | null {
  if (thread.parentThreadId === null) return null;
  const parent = getThread(db, thread.parentThreadId);
  const live = parent?.archivedAt === null && parent.deletedAt === null;
  return parent !== undefined && live ? parent : null;
}

export function resolveTurnExecution(
  db: Db,
  thread: ThreadRow,
  request: ExecutionRequest,
): ExecutionTuple {
  const stored = readProjectExecutionDefaults(db, thread.projectId);
  const defaults = stored?.providerId === thread.providerId ? stored : null;
  const asked = namedFields(request);
  const model =
    asked.model ?? thread.modelOverride ?? thread.model ?? defaults?.model;
  if (model === undefined) {
    const message = `Thread ${thread.id} has no stored execution model`;
    throw new ApiError(500, "internal_error", message);
  }
  const environment =
    thread.environmentId === null
      ? undefined
      : getEnvironmentRow(db, thread.environmentId);
  return {
    model,
    reasoningLevel:
      asked.reasoningLevel ??
      thread.reasoningLevelOverride ??
      thread.reasoningLevel ??
      defaults?.reasoningLevel ??
      DEFAULT_REASONING_LEVEL,
    permissionMode: clampToHost(
      db,
      environment?.hostId ?? null,
      asked.permissionMode ??
        thread.permissionMode ??
        liveParentOf(db, thread)?.permissionMode ??
        defaults?.permissionMode ??
        DEFAULT_PERMISSION_MODE,
    ),
    serviceTier: serviceTierFor(db, [
      asked.serviceTier,
      thread.serviceTier,
      defaults?.serviceTier,
    ]),
  };
}

async function firstInstalledProvider(
  ctx: EngineContext,
  hostId: string,
): Promise<string> {
  const { providerOrder } = getAppSettings(ctx.db);
  const rank = (providerId: string): number => {
    const index = providerOrder.indexOf(providerId);
    return index < 0 ? providerOrder.length : index;
  };
  const installed = (await ctx.runners.get(hostId).listProviders())
    .filter((provider) => provider.installed)
    .map((provider) => provider.providerId)
    .sort((left, right) => rank(left) - rank(right));
  if (installed.length > 0) return installed[0];
  throw new ApiError(
    409,
    "no_provider_available",
    "No agent provider is installed on this machine. Install Codex or " +
      "Claude Code to start a thread.",
  );
}

async function catalogDefaultModel(
  ctx: EngineContext,
  hostId: string,
  providerId: ProviderId,
): Promise<string> {
  const runner = ctx.runners.get(hostId);
  const { models } = await runner.listModels({ providerId, cwd: null });
  const model = models.find((candidate) => candidate.isDefault) ?? models.at(0);
  if (model !== undefined) return model.model;
  throw new ApiError(
    503,
    "model_catalog_unavailable",
    `The ${providerId} model catalog is empty, so no default model can ` +
      "be resolved. Pick a model explicitly.",
    { retryable: true },
  );
}

export async function resolveCreateExecution(
  ctx: EngineContext,
  args: CreateExecutionArgs,
): Promise<{ providerId: ProviderId; execution: ExecutionTuple }> {
  const { request, hostId, parent } = args;
  const { db } = ctx;
  const stored = readProjectExecutionDefaults(db, args.projectId);
  const providerId = requireProviderId(
    request.providerId ??
      stored?.providerId ??
      getAppSettings(db).defaultProviderId ??
      (await firstInstalledProvider(ctx, hostId)),
  );
  const defaults: ProjectExecutionDefaults | null =
    stored?.providerId === providerId ? stored : null;
  const asked = namedFields(request);
  const execution: ExecutionTuple = {
    model:
      asked.model ??
      defaults?.model ??
      (await catalogDefaultModel(ctx, hostId, providerId)),
    reasoningLevel:
      asked.reasoningLevel ??
      defaults?.reasoningLevel ??
      DEFAULT_REASONING_LEVEL,
    permissionMode: clampToHost(
      db,
      hostId,
      asked.permissionMode ??
        parent?.permissionMode ??
        defaults?.permissionMode ??
        DEFAULT_PERMISSION_MODE,
    ),
    serviceTier: serviceTierFor(db, [asked.serviceTier, defaults?.serviceTier]),
  };
  return { providerId, execution };
}

export function recordedExecution(
  execution: ExecutionTuple,
): ResolvedThreadExecutionOptions {
  return { ...execution, source: "client/turn/requested" };
}

export function toRunnerOptions(
  execution: ExecutionTuple,
  initiator: ThreadTurnInitiator,
  input: readonly PromptInput[],
): ExecutionOptions {
  return {
    ...execution,
    permissionEscalation: initiator === "user" ? "ask" : "deny",
    planMode: promptInputHasCommandMention(input, {
      trigger: "/",
      name: "plan",
    }),
    providerOptions: {},
  };
}
