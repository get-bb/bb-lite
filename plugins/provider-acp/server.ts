import {
  machines,
  sessions,
  type PluginServerApi,
  type ProviderDeclaration,
} from "@bb/plugin";
import { acp, acpMachine } from "./contract.js";
import { runnerAgent, type AcpAgentDefinition } from "./src/agents.js";
import { resolveConfiguredAcpAgents } from "./src/configured-agents.js";
import { acpProviderDeclaration } from "./src/declaration.js";
import {
  KNOWN_ACP_AGENTS,
  RESERVED_ACP_PROVIDER_IDS,
} from "./src/known-agents.js";
import { applyAcpAgentProbe } from "./src/probe-capabilities.js";
import { createAcpRegistry } from "./src/registry-service.js";

const CUSTOM_AGENTS_SETTING_DESCRIPTION =
  "A JSON array of ACP agents to add. Each entry needs id, displayName and " +
  "command; see the guide for the optional fields.";

const REGISTRY_PROVIDER_IDS_OF_SHIPPED_AGENTS = ["acp-grok-build"];

interface Registered {
  key: string;
  remove(): void;
}

function needsProbe(agent: AcpAgentDefinition): boolean {
  return agent.visibility === "installed" || (agent.fork ?? "none") !== "none";
}

export default function acpProvidersPlugin(bb: PluginServerApi): void {
  const settings = bb.settings.define({
    customAgents: {
      type: "string",
      label: "Custom agents",
      description: CUSTOM_AGENTS_SETTING_DESCRIPTION,
      multiline: true,
      default: "",
    },
  });

  const registry = createAcpRegistry({
    kv: bb.storage.kv,
    debug: (message) => bb.log.debug(message),
    readCustomAgents: async () => (await settings.get()).customAgents,
    writeCustomAgents: async (value) => {
      await settings.set({ customAgents: value });
    },
    reservedProviderIds: new Set([
      ...KNOWN_ACP_AGENTS.map((agent) => agent.id),
      ...REGISTRY_PROVIDER_IDS_OF_SHIPPED_AGENTS,
    ]),
  });
  bb.implement(acp.registry, ({ refresh }) => registry.view(refresh));
  bb.implement(acp.add, ({ id }) => registry.add(id));
  bb.implement(acp.remove, ({ id }) => registry.remove(id));

  const providers = new Map<string, Registered>();
  const usage = new Map<string, Registered>();
  const narrowed = new Map<string, AcpAgentDefinition>();
  const installedOn = new Map<string, Set<string>>();
  let configuredAgents: readonly AcpAgentDefinition[] = [];

  function desiredAgents(): AcpAgentDefinition[] {
    const configuredIds = new Set(configuredAgents.map((agent) => agent.id));
    return [
      ...KNOWN_ACP_AGENTS.filter((agent) => !configuredIds.has(agent.id)).map(
        (agent) => narrowed.get(agent.id) ?? agent,
      ),
      ...configuredAgents,
    ];
  }

  function visibleAgents(): AcpAgentDefinition[] {
    return desiredAgents().filter(
      (agent) =>
        agent.visibility !== "installed" ||
        (installedOn.get(agent.id)?.size ?? 0) > 0,
    );
  }

  function sync(
    current: Map<string, Registered>,
    desired: Map<string, { key: string; add(): () => void }>,
  ): void {
    for (const [id, entry] of [...current]) {
      if (desired.get(id)?.key === entry.key) continue;
      entry.remove();
      current.delete(id);
    }
    for (const [id, next] of desired) {
      if (current.has(id)) continue;
      try {
        current.set(id, { key: next.key, remove: next.add() });
      } catch (error) {
        bb.log.error(`Could not register ACP provider "${id}": ${error}`);
      }
    }
  }

  function addProvider(declaration: ProviderDeclaration) {
    return () => bb.add(sessions.provider, declaration);
  }

  function addUsage(providerId: string) {
    return () =>
      bb.add(sessions.usage, {
        providerId,
        scope: "host",
        read: ({ hostId }) =>
          bb.runners.call(hostId ?? bb.runners.localHostId, acpMachine.usage, {
            providerId,
          }),
      });
  }

  function reconcile(): void {
    const agents = visibleAgents();
    sync(
      providers,
      new Map(
        agents.map((agent) => [
          agent.id,
          {
            key: JSON.stringify(agent),
            add: addProvider(acpProviderDeclaration(agent)),
          },
        ]),
      ),
    );
    sync(
      usage,
      new Map(
        agents
          .filter((agent) => agent.providerUsage === true)
          .map((agent) => [
            agent.id,
            { key: agent.id, add: addUsage(agent.id) },
          ]),
      ),
    );
  }

  async function configure(hostId: string): Promise<void> {
    try {
      await bb.runners.call(hostId, acpMachine.configure, {
        agents: desiredAgents().map(runnerAgent),
      });
    } catch (error) {
      bb.log.warn(`Could not configure ACP agents on ${hostId}: ${error}`);
    }
  }

  async function configureAll(): Promise<void> {
    await Promise.all(bb.runners.connectedHostIds().map(configure));
  }

  async function disabledProviderIds(): Promise<Set<string>> {
    try {
      const catalog = await bb.call(sessions.providerCatalog, {});
      return new Set(
        catalog.filter((entry) => !entry.enabled).map((entry) => entry.id),
      );
    } catch {
      return new Set();
    }
  }

  async function probe(hostId: string): Promise<void> {
    const configuredIds = new Set(configuredAgents.map((agent) => agent.id));
    const disabled = await disabledProviderIds();
    let forkChanged = false;
    for (const shipped of KNOWN_ACP_AGENTS) {
      if (configuredIds.has(shipped.id) || disabled.has(shipped.id)) continue;
      const agent = narrowed.get(shipped.id) ?? shipped;
      if (!needsProbe(agent)) continue;
      let result;
      try {
        result = await bb.runners.call(hostId, acpMachine.probe, {
          command: agent.launch.command,
          args: agent.launch.args,
          env: agent.launch.env,
        });
      } catch (error) {
        bb.log.debug(`Could not probe ${agent.id} on ${hostId}: ${error}`);
        continue;
      }
      const hosts = installedOn.get(agent.id) ?? new Set<string>();
      if (result.reachable) hosts.add(hostId);
      else hosts.delete(hostId);
      installedOn.set(agent.id, hosts);
      const applied = applyAcpAgentProbe(agent, result);
      if (applied !== null) {
        bb.log.info(`${agent.id} on ${hostId}: ${applied.reason}.`);
        narrowed.set(agent.id, applied.agent);
        forkChanged = true;
      }
    }
    reconcile();
    if (forkChanged) await configureAll();
  }

  async function machineConnected(hostId: string): Promise<void> {
    await configure(hostId);
    await probe(hostId);
  }

  function applySetting(value: string): void {
    const resolved = resolveConfiguredAcpAgents({
      settingValue: value,
      reservedProviderIds: RESERVED_ACP_PROVIDER_IDS,
      shippedAgents: KNOWN_ACP_AGENTS,
    });
    for (const warning of resolved.warnings) bb.log.warn(warning);
    configuredAgents = resolved.agents;
    reconcile();
    if (resolved.agents.length > 0) {
      bb.log.info(
        `Registered ${resolved.agents.length} configured ACP agent(s).`,
      );
    }
  }

  let pending: Promise<void> = Promise.resolve();
  function queue(task: () => Promise<void>): Promise<void> {
    pending = pending.then(task).catch((error: unknown) => {
      bb.log.error(`ACP providers: ${error}`);
    });
    return pending;
  }

  reconcile();
  bb.on(machines.connected, ({ hostId }) => {
    void queue(() => machineConnected(hostId));
  });
  bb.on(machines.disconnected, ({ hostId }) => {
    for (const hosts of installedOn.values()) hosts.delete(hostId);
    reconcile();
  });
  settings.onChange((next) => {
    void queue(async () => {
      applySetting(next.customAgents);
      await configureAll();
    });
  });
  bb.onStart(() => {
    void queue(async () => {
      applySetting((await settings.get()).customAgents);
      for (const hostId of bb.runners.connectedHostIds()) {
        await machineConnected(hostId);
      }
    });
  });
}
