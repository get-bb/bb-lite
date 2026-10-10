import type { PluginServerApi } from "@bb/plugin";
import * as domain from "@bb/domain";
import type { ExecutionOptions, ProviderId } from "@bb/runner";
import { getEnvironment } from "@bb/server-kit/db/environments";
import { findHost } from "@bb/server-kit/db/hosts";
import type { Db } from "@bb/server-kit/db/index";
import { getProjectExecutionDefaults } from "@bb/server-kit/db/projects";
import { getAppSettings } from "@bb/server-kit/db/settings";
import { getThread, type ThreadRow } from "@bb/server-kit/db/threads";
import { ApiError, invalidRequest } from "@bb/server-kit/http/errors";
import {
  findProviderDefinition,
  listProviderDefinitions,
} from "@bb/server-kit/providers/catalog";
import { providerOptionsFor } from "@bb/server-kit/providers/settings";

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

function supportedPermissionMode(
  modes: readonly domain.PermissionMode[] | undefined,
  preferred: domain.PermissionMode,
): domain.PermissionMode {
  if (modes === undefined || modes.includes(preferred)) return preferred;
  for (const fallback of ["auto", "full"] as const) {
    if (modes.includes(fallback)) return fallback;
  }
  return modes[0] ?? preferred;
}

function resolve(
  db: Db,
  hostId: string | null,
  providerId: string,
  model: string,
  layers: Stored[],
): ExecutionTuple {
  const pick = <Field extends ExecutionField>(field: Field) =>
    layers.map((layer) => layer[field]).find((value) => value != null);
  const host = hostId === null ? undefined : findHost(db, "id", hostId);
  const provider = findProviderDefinition(db, providerId);
  const permissionModes = provider?.info.capabilities.permissionModes;
  const preferred = pick("permissionMode") ?? "auto";
  const permissionMode = supportedPermissionMode(permissionModes, preferred);
  const ceiling = host?.maxPermissionMode ?? "full";
  const fast = getAppSettings(db).allowFastServiceTier;
  return {
    model,
    reasoningLevel: pick("reasoningLevel") ?? "medium",
    permissionMode:
      domain.clampPermissionModeToCeiling({
        ceiling,
        permissionMode,
        permissionModes,
      }) ?? permissionMode,
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
  const hostId = environment?.hostId ?? null;
  return resolve(db, hostId, thread.providerId, model, layers);
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
  bb: PluginServerApi,
  hostId: string,
): Promise<string> {
  const { providerOrder } = getAppSettings(bb.db);
  const enabled = new Set(listProviderDefinitions(bb.db).map(({ id }) => id));
  const rank = (providerId: string) =>
    (providerOrder.indexOf(providerId) + 1 || providerOrder.length + 1) - 1;
  const [first] = (await bb.runners.get(hostId).listProviders())
    .filter((provider) => provider.installed)
    .filter((provider) => enabled.has(provider.providerId))
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
  bb: PluginServerApi,
  hostId: string,
  providerId: ProviderId,
) {
  const runner = bb.runners.get(hostId);
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
  bb: PluginServerApi,
  args: CreateExecutionArgs,
): Promise<{ providerId: ProviderId; execution: ExecutionTuple }> {
  const { request, projectId, hostId, parent } = args;
  const { db } = bb;
  const enabled = new Set(listProviderDefinitions(db).map(({ id }) => id));
  const remembered = [
    getProjectExecutionDefaults(db, projectId)?.providerId,
    getAppSettings(db).defaultProviderId,
  ].find((candidate) => candidate != null && enabled.has(candidate));
  const providerId = requireProviderId(
    db,
    request.providerId ??
      remembered ??
      (await firstInstalledProvider(bb, hostId)),
  );
  const asked = namedFields(request);
  const defaults: Stored = projectDefaults(db, projectId, providerId);
  const inherited = { permissionMode: parent?.permissionMode };
  const model =
    asked.model ??
    defaults.model ??
    (await catalogDefaultModel(bb, hostId, providerId));
  const layers = [asked, inherited, defaults];
  const execution = resolve(db, hostId, providerId, model, layers);
  return { providerId, execution };
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
