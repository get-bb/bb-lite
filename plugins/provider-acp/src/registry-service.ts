import { readFile } from "node:fs/promises";
import { fail, type PluginKv } from "@bb/plugin";
import { z } from "zod";
import { iconBytes } from "./declaration.js";
import {
  ACP_REGISTRY_URL,
  describeRegistryAgents,
  parseAcpRegistry,
  settingWithRegistryAgent,
  settingWithoutAgent,
  type AcpRegistryAgent,
} from "./registry.js";
import {
  registryAgentViewBaseSchema,
  type AcpRegistryView,
} from "./registry-view.js";

const REGISTRY_CACHE_KEY = "registry";
const REGISTRY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REGISTRY_FETCH_TIMEOUT_MS = 15_000;
export const REGISTRY_URL_ENV = "BB_ACP_REGISTRY_URL";

const cachedRegistrySchema = z.object({
  fetchedAt: z.number(),
  agents: z.array(registryAgentViewBaseSchema),
});

interface LoadedRegistry {
  agents: AcpRegistryAgent[];
  fetchedAt: number | null;
  error: string | null;
}

export interface AcpRegistryDeps {
  kv: PluginKv;
  debug(message: string): void;
  readCustomAgents(): Promise<string>;
  writeCustomAgents(value: string): Promise<void>;
  reservedProviderIds: ReadonlySet<string>;
  fetchDocument?: () => Promise<unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function fetchRegistryDocument(): Promise<unknown> {
  const url = process.env[REGISTRY_URL_ENV] ?? ACP_REGISTRY_URL;
  if (url.startsWith("file:")) {
    return JSON.parse(await readFile(new URL(url), "utf8"));
  }
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`The ACP registry answered ${response.status}.`);
  }
  return response.json();
}

function iconDataUrl(name: string | null): string | null {
  if (name === null) return null;
  const svg = Buffer.from(iconBytes(name)).toString("base64");
  return `data:image/svg+xml;base64,${svg}`;
}

export function createAcpRegistry(deps: AcpRegistryDeps) {
  const fetchDocument = deps.fetchDocument ?? fetchRegistryDocument;

  async function readCache() {
    const cached = cachedRegistrySchema.safeParse(
      await deps.kv.get<unknown>(REGISTRY_CACHE_KEY),
    );
    return cached.success ? cached.data : null;
  }

  async function loadRegistry(refresh: boolean): Promise<LoadedRegistry> {
    const cached = await readCache();
    if (
      cached !== null &&
      !refresh &&
      Date.now() - cached.fetchedAt < REGISTRY_CACHE_TTL_MS
    ) {
      return { ...cached, error: null };
    }
    try {
      const parsed = parseAcpRegistry(await fetchDocument());
      const fetchedAt = Date.now();
      await deps.kv.set(REGISTRY_CACHE_KEY, {
        fetchedAt,
        agents: parsed.agents,
      });
      if (parsed.skipped > 0) {
        deps.debug(
          `Skipped ${parsed.skipped} ACP registry entries bb could not read.`,
        );
      }
      return { agents: parsed.agents, fetchedAt, error: null };
    } catch (error) {
      return {
        agents: cached?.agents ?? [],
        fetchedAt: cached?.fetchedAt ?? null,
        error: errorMessage(error),
      };
    }
  }

  async function view(refresh: boolean): Promise<AcpRegistryView> {
    const loaded = await loadRegistry(refresh);
    const agents = describeRegistryAgents({
      agents: loaded.agents,
      settingValue: await deps.readCustomAgents(),
      reservedProviderIds: deps.reservedProviderIds,
    });
    return {
      fetchedAt: loaded.fetchedAt,
      error: loaded.error,
      agents: agents.map((agent) => ({
        ...agent,
        icon: iconDataUrl(agent.icon),
      })),
    };
  }

  async function writeSetting(change: (value: string) => string) {
    let next: string;
    try {
      next = change(await deps.readCustomAgents());
    } catch (error) {
      fail("invalid", errorMessage(error), {
        reason: "acp_agent_change_failed",
        hint: "Run `bb acp registry` to see the agents and their ids.",
      });
    }
    await deps.writeCustomAgents(next);
  }

  async function add(id: string): Promise<AcpRegistryView> {
    const loaded = await loadRegistry(false);
    const agent = loaded.agents.find((candidate) => candidate.id === id);
    if (agent === undefined) {
      fail(
        "not_found",
        loaded.error === null
          ? `The ACP registry has no agent "${id}".`
          : `The ACP registry could not be loaded: ${loaded.error}`,
        {
          reason: "acp_agent_change_failed",
          hint: "Run `bb acp registry` to see the agents and their ids.",
        },
      );
    }
    if (deps.reservedProviderIds.has(`acp-${id}`)) {
      fail("conflict", `${agent.name} is already built into bb.`, {
        reason: "acp_agent_change_failed",
      });
    }
    await writeSetting((value) => settingWithRegistryAgent(value, agent));
    return view(false);
  }

  async function remove(id: string): Promise<AcpRegistryView> {
    await writeSetting((value) => settingWithoutAgent(value, id));
    return view(false);
  }

  return { view, add, remove };
}
