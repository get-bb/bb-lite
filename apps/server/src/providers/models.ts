import { readFile } from "node:fs/promises";
import { reasoningEffortsForLevels, type AvailableModel } from "@bb/domain";
import type { ProviderModels } from "@bb/runner";
import type {
  SystemExecutionOptionsModelLoadError,
  SystemExecutionOptionsQuery,
  SystemExecutionOptionsResponse,
} from "@bb/server-contract";
import { z } from "zod";
import { dataPaths } from "../config.js";
import type { ServerContext } from "../context.js";
import { getAppSettings } from "../db/settings.js";
import { errorMessage, invalidRequest, toApiError } from "../http/errors.js";
import { requireHost, resolveLookupHostId } from "../runners/hosts.js";
import {
  findProviderDefinition,
  listEnabledProviders,
  type ProviderDefinition,
} from "./catalog.js";

interface CatalogEntry {
  models: ProviderModels | null;
  loadedAt: number;
  failure: SystemExecutionOptionsModelLoadError | null;
  pending: Promise<void> | null;
}

type LoadedModels = Pick<
  SystemExecutionOptionsResponse,
  "models" | "selectedOnlyModels" | "modelLoadError"
>;

const FRESH_MS = 10 * 60_000;
const FAILURE_TTL_MS = 30_000;
const FAILURE_DETAIL_MAX_LENGTH = 300;

const customModelsSchema = z.object({
  customModels: z
    .array(
      z.object({
        providerId: z.string().min(1),
        model: z.string().min(1),
        displayName: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
        env: z.record(z.string(), z.string()).default({}),
        unsetEnv: z.array(z.string().min(1)).default([]),
      }),
    )
    .default([]),
});
type CustomModel = z.infer<typeof customModelsSchema>["customModels"][number];

function modelLoadError(
  providerId: string,
  error: unknown,
): SystemExecutionOptionsModelLoadError {
  const known = toApiError(error)?.body.code;
  const detail = errorMessage(error).replace(/\s+/gu, " ").trim();
  const code =
    known === "missing_executable" || known === "auth_required"
      ? known
      : "failed";
  return {
    providerId,
    code,
    detail: detail.slice(0, FAILURE_DETAIL_MAX_LENGTH) || null,
  };
}

export class ModelCatalog {
  private readonly entries = new Map<string, CatalogEntry>();

  constructor(private readonly ctx: ServerContext) {
    ctx.runners.onConnected((hostId) => {
      for (const key of this.entries.keys()) {
        if (key.startsWith(`${hostId}\0`)) this.entries.delete(key);
      }
    });
  }

  async read(hostId: string, provider: ProviderDefinition) {
    const key = `${hostId}\0${provider.id}`;
    const entry: CatalogEntry = this.entries.get(key) ?? {
      models: null,
      loadedAt: 0,
      failure: null,
      pending: null,
    };
    this.entries.set(key, entry);
    const age = this.ctx.now() - entry.loadedAt;
    if (
      entry.models === null &&
      (entry.failure === null || age >= FAILURE_TTL_MS)
    ) {
      await this.refresh(entry, hostId, provider);
    } else if (entry.models !== null && age >= FRESH_MS) {
      void this.refresh(entry, hostId, provider);
    }
    const { models, selectedOnlyModels } = entry.models ?? {
      models: [],
      selectedOnlyModels: [],
    };
    const failure = entry.models === null ? entry.failure : null;
    return { models, selectedOnlyModels, modelLoadError: failure };
  }

  private refresh(
    entry: CatalogEntry,
    hostId: string,
    provider: ProviderDefinition,
  ): Promise<void> {
    entry.pending ??= this.load(entry, hostId, provider).finally(() => {
      entry.pending = null;
    });
    return entry.pending;
  }

  private async load(
    entry: CatalogEntry,
    hostId: string,
    { id: providerId }: ProviderDefinition,
  ): Promise<void> {
    const previous = entry.models;
    try {
      const runner = this.ctx.runners.get(hostId);
      entry.models = await runner.listModels({ providerId, cwd: null });
      entry.failure = null;
    } catch (error) {
      entry.failure = modelLoadError(providerId, error);
    }
    entry.loadedAt = this.ctx.now();
    const changed = JSON.stringify(previous) !== JSON.stringify(entry.models);
    if (previous !== null && changed) {
      this.ctx.hub.host(hostId, ["provider-model-catalog-changed"]);
    }
  }
}

const catalogs = new WeakMap<ServerContext, ModelCatalog>();

export function modelCatalog(ctx: ServerContext): ModelCatalog {
  const catalog = catalogs.get(ctx) ?? new ModelCatalog(ctx);
  catalogs.set(ctx, catalog);
  return catalog;
}

async function readCustomModels(ctx: ServerContext) {
  if (getAppSettings(ctx.db).streamerMode) return [];
  return readCustomModelConfig(ctx);
}

export async function readCustomModelConfig(ctx: ServerContext) {
  const path = dataPaths(ctx.config.dataDir).configFile;
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return [];
  try {
    return customModelsSchema.parse(JSON.parse(text)).customModels;
  } catch (error) {
    ctx.log.warn("Ignoring customModels: config.json is invalid", {
      err: error,
      path,
    });
    return [];
  }
}

function withCustomModels(
  loaded: LoadedModels,
  provider: ProviderDefinition,
  customModels: CustomModel[],
): LoadedModels {
  const models = [...loaded.models];
  let { selectedOnlyModels } = loaded;
  for (const custom of customModels) {
    const { model, providerId } = custom;
    if (providerId !== provider.id) continue;
    if (models.some((known) => known.model === model)) continue;
    const promoted = selectedOnlyModels.find((known) => known.model === model);
    selectedOnlyModels = selectedOnlyModels.filter(
      (known) => known !== promoted,
    );
    const added: AvailableModel = promoted ?? {
      id: model,
      model,
      displayName: custom.displayName ?? model,
      description: custom.description ?? "Custom model from config.json",
      supportedReasoningEfforts: reasoningEffortsForLevels(
        provider.reasoningLevels,
      ),
      defaultReasoningEffort: "medium",
      isDefault: false,
    };
    models.push(added);
  }
  return { ...loaded, models, selectedOnlyModels };
}

export async function resolveExecutionOptions(
  ctx: ServerContext,
  query: SystemExecutionOptionsQuery,
): Promise<SystemExecutionOptionsResponse> {
  const { db } = ctx;
  const hostId = resolveLookupHostId(ctx, query);
  const permissionCeiling = requireHost(ctx, hostId).maxPermissionMode;
  const enabled = listEnabledProviders(db);
  const providers = enabled.map((provider) => provider.info);
  const { providerId } = query;
  if (providerId !== undefined && !findProviderDefinition(db, providerId)) {
    throw invalidRequest(`Unsupported provider ${providerId}`);
  }
  const provider =
    providerId === undefined
      ? enabled[0]
      : enabled.find(({ id }) => id === providerId);
  if (provider === undefined) {
    const none = { models: [], selectedOnlyModels: [], modelLoadError: null };
    return { providers, permissionCeiling, ...none };
  }
  const loaded = await modelCatalog(ctx).read(hostId, provider);
  const customModels = await readCustomModels(ctx);
  const merged = withCustomModels(loaded, provider, customModels);
  return { providers, permissionCeiling, ...merged };
}
