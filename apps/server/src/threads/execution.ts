import * as domain from "@bb/domain";
import type { ExecutionOptions, ProviderId } from "@bb/runner";
import type { ServerContext } from "../context.js";
import { getEnvironment } from "../db/environments.js";
import { findHost } from "../db/hosts.js";
import type { Db } from "../db/index.js";
import { getProjectExecutionDefaults } from "../db/projects.js";
import { getAppSettings } from "../db/settings.js";
import { getThread, type ThreadRow } from "../db/threads.js";
import { ApiError, invalidRequest } from "../http/errors.js";
import { listProviderDefinitions } from "../providers/catalog.js";
import { providerOptionsFor } from "../providers/settings.js";

export type ExecutionTuple = Omit<
  domain.ResolvedThreadExecutionOptions,
  "source"
>;

type ExecutionField = keyof ExecutionTuple;
type Stored = { [Field in ExecutionField]?: ExecutionTuple[Field] | null };

export interface ExecutionRequest extends Partial<ExecutionTuple> {
  executionInputSources?: Partial<
    Record<ExecutionField, domain.CallerExecutionInputSource>
  >;
}

interface CreateExecutionArgs {
  request: ExecutionRequest & { providerId?: string };
  projectId: string;
  hostId: string;
  parent: ThreadRow | null;
}

interface TurnOptionsSource {
  execution: ExecutionTuple;
  initiator: domain.ThreadTurnInitiator;
}

export function requireProviderId(db: Db, value: string): ProviderId {
  const ids = listProviderDefinitions(db).map(({ id }) => id);
  if (ids.includes(value)) return value;
  throw invalidRequest(`Unknown provider "${value}". Use ${ids.join(", ")}.`);
}

function namedFields(request: ExecutionRequest): Partial<ExecutionTuple> {
  const sources = request.executionInputSources;
  const named = (field: ExecutionField) =>
    sources === undefined || sources[field] !== undefined;
  const { model, reasoningLevel, permissionMode, serviceTier } = request;
  return {
    ...(named("model") && model ? { model } : {}),
    ...(named("reasoningLevel") && reasoningLevel ? { reasoningLevel } : {}),
    ...(named("permissionMode") && permissionMode ? { permissionMode } : {}),
    ...(named("serviceTier") && serviceTier ? { serviceTier } : {}),
  };
}

function resolve(
  db: Db,
  hostId: string | null,
  model: string,
  layers: Stored[],
): ExecutionTuple {
  const pick = <Field extends ExecutionField>(field: Field) =>
    layers.map((layer) => layer[field]).find((value) => value != null);
  const host = hostId === null ? undefined : findHost(db, "id", hostId);
  const permissionMode = pick("permissionMode") ?? "auto";
  const ceiling = host?.maxPermissionMode ?? "full";
  const fast = getAppSettings(db).allowFastServiceTier;
  return {
    model,
    reasoningLevel: pick("reasoningLevel") ?? "medium",
    permissionMode:
      domain.clampPermissionModeToCeiling({ ceiling, permissionMode }) ??
      permissionMode,
    serviceTier: (fast ? pick("serviceTier") : null) ?? "default",
  };
}

function projectDefaults(db: Db, projectId: string, providerId: string) {
  const stored = getProjectExecutionDefaults(db, projectId);
  return stored?.providerId === providerId ? stored : {};
}

export function findTurnExecution(
  db: Db,
  thread: ThreadRow,
  request: ExecutionRequest,
): ExecutionTuple | null {
  const asked = namedFields(request);
  const defaults = projectDefaults(db, thread.projectId, thread.providerId);
  const overrides = {
    model: thread.modelOverride,
    reasoningLevel: thread.reasoningLevelOverride,
  };
  const { parentThreadId, environmentId } = thread;
  const parent =
    parentThreadId === null ? undefined : getThread(db, parentThreadId);
  const live = parent?.archivedAt === null && parent.deletedAt === null;
  const inherited = { permissionMode: live ? parent?.permissionMode : null };
  const layers = [asked, overrides, thread, inherited, defaults];
  const model = layers.map((layer: Stored) => layer.model).find(Boolean);
  if (model == null) return null;
  const environment =
    environmentId === null ? undefined : getEnvironment(db, environmentId);
  return resolve(db, environment?.hostId ?? null, model, layers);
}

export function resolveTurnExecution(
  db: Db,
  thread: ThreadRow,
  request: ExecutionRequest,
): ExecutionTuple {
  const execution = findTurnExecution(db, thread, request);
  if (execution !== null) return execution;
  const message = `Thread ${thread.id} has no stored execution model`;
  throw new ApiError(500, "internal_error", message);
}

async function firstInstalledProvider(
  ctx: ServerContext,
  hostId: string,
): Promise<string> {
  const { providerOrder } = getAppSettings(ctx.db);
  const rank = (providerId: string) =>
    (providerOrder.indexOf(providerId) + 1 || providerOrder.length + 1) - 1;
  const [first] = (await ctx.runners.get(hostId).listProviders())
    .filter((provider) => provider.installed)
    .map((provider) => provider.providerId)
    .sort((left, right) => rank(left) - rank(right));
  if (first !== undefined) return first;
  throw new ApiError(
    409,
    "no_provider_available",
    "No agent provider is installed on this machine. Install Codex or " +
      "Claude Code to start a thread.",
  );
}

async function catalogDefaultModel(
  ctx: ServerContext,
  hostId: string,
  providerId: ProviderId,
) {
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
  ctx: ServerContext,
  args: CreateExecutionArgs,
): Promise<{ providerId: ProviderId; execution: ExecutionTuple }> {
  const { request, projectId, hostId, parent } = args;
  const { db } = ctx;
  const providerId = requireProviderId(
    db,
    request.providerId ??
      getProjectExecutionDefaults(db, projectId)?.providerId ??
      getAppSettings(db).defaultProviderId ??
      (await firstInstalledProvider(ctx, hostId)),
  );
  const asked = namedFields(request);
  const defaults: Stored = projectDefaults(db, projectId, providerId);
  const inherited = { permissionMode: parent?.permissionMode };
  const model =
    asked.model ??
    defaults.model ??
    (await catalogDefaultModel(ctx, hostId, providerId));
  const layers = [asked, inherited, defaults];
  return { providerId, execution: resolve(db, hostId, model, layers) };
}

export function recordedExecution(
  execution: ExecutionTuple,
): domain.ResolvedThreadExecutionOptions {
  return { ...execution, source: "client/turn/requested" };
}

export function toRunnerOptions(
  db: Db,
  providerId: string,
  { execution, initiator }: TurnOptionsSource,
): ExecutionOptions {
  return {
    ...execution,
    permissionEscalation: initiator === "user" ? "ask" : "deny",
    providerOptions: providerOptionsFor(db, providerId),
  };
}
