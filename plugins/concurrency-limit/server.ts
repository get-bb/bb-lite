import {
  cliCommand,
  defineCli,
  machines,
  PluginCliError,
  projects,
  threads,
  type PluginServerApi,
} from "@bb/plugin";
import { z } from "zod";
import {
  concurrencyLimit,
  configurationSchema,
  MAX_LIMIT_VALUE,
  parseLimitValue,
  type Configuration,
  type HostLimit,
} from "./contract.js";

const CONFIGURATION_KEY = "configuration";
const CAPACITIES_KEY = "host-capacities";
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const MAX_REASON_LENGTH = 200;
const RUNNING = new Set(["active", "starting"]);
const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

const capacitiesSchema = z.record(z.string(), z.number().int().positive());

function normalize(configuration: Configuration): Configuration {
  const hostOverrides = [...configuration.hostOverrides].sort((a, b) =>
    a.hostId.localeCompare(b.hostId),
  );
  return { globalLimit: configuration.globalLimit, hostOverrides };
}

function waitReason(limit: number, scope: string): string {
  const reason = `${limit} of ${limit} running on ${scope}`;
  return reason.length <= MAX_REASON_LENGTH
    ? reason
    : `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

function parseLimitArgument(raw: string, keyword: "auto" | "unlimited") {
  if (raw === keyword) return null;
  const value = parseLimitValue(raw);
  if (value !== null) return value;
  throw new PluginCliError(
    `Limit must be ${keyword} or a whole number from 0 to ${MAX_LIMIT_VALUE}`,
    { code: "invalid_limit" },
  );
}

function formatHost(host: HostLimit): string {
  const source =
    host.override === null
      ? `auto, ${host.effectiveLimit}`
      : String(host.override);
  const processors =
    host.availableParallelism === null
      ? "processors unknown"
      : `${host.availableParallelism} processors`;
  return `${host.name}: ${source} (${processors}, ${host.status})`;
}

export default async function concurrencyLimitPlugin(
  bb: PluginServerApi,
): Promise<void> {
  const stored = configurationSchema.safeParse(
    await bb.storage.kv.get(CONFIGURATION_KEY),
  );
  let configuration: Configuration = stored.success
    ? normalize(stored.data)
    : { globalLimit: null, hostOverrides: [] };
  const storedCapacities = capacitiesSchema.safeParse(
    await bb.storage.kv.get(CAPACITIES_KEY),
  );
  const capacities = new Map(
    Object.entries(storedCapacities.success ? storedCapacities.data : {}),
  );

  function hostLimit(hostId: string): number {
    const override = configuration.hostOverrides.find(
      (candidate) => candidate.hostId === hostId,
    );
    return override?.limit ?? capacities.get(hostId) ?? 1;
  }

  async function view() {
    const hosts = await bb.call(machines.list, {});
    return {
      ...configuration,
      hosts: hosts.map(({ id, name, status }): HostLimit => {
        const availableParallelism = capacities.get(id) ?? null;
        const override =
          configuration.hostOverrides.find((entry) => entry.hostId === id)
            ?.limit ?? null;
        return {
          id,
          name,
          status,
          availableParallelism,
          automaticLimit: availableParallelism ?? 1,
          effectiveLimit: hostLimit(id),
          override,
        };
      }),
    };
  }

  async function releaseWaiting(): Promise<void> {
    const list = await bb.call(threads.list, { includeHidden: true });
    for (const thread of list) {
      if (thread.queuedWork !== "waiting") continue;
      await bb.call(threads.release, { threadId: thread.id });
    }
  }

  async function save(next: Configuration): Promise<void> {
    configuration = normalize(next);
    await bb.storage.kv.set(CONFIGURATION_KEY, configuration);
    bb.changed(concurrencyLimit.get);
    await releaseWaiting();
  }

  const retries = new Map<string, ReturnType<typeof setTimeout>>();
  bb.onDispose(() => {
    for (const timer of retries.values()) clearTimeout(timer);
  });

  async function detect(hostId: string, retryMs = RETRY_MIN_MS) {
    clearTimeout(retries.get(hostId));
    retries.delete(hostId);
    try {
      const { availableParallelism } = await bb.runners.call(
        hostId,
        concurrencyLimit.capacity,
        {},
      );
      if (capacities.get(hostId) === availableParallelism) return;
      capacities.set(hostId, availableParallelism);
      await bb.storage.kv.set(CAPACITIES_KEY, Object.fromEntries(capacities));
      bb.changed(concurrencyLimit.get);
      await releaseWaiting();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      bb.log.warn(`Could not detect capacity for host ${hostId}: ${message}`);
      const next = Math.min(retryMs * 2, RETRY_MAX_MS);
      const retry = () => void detect(hostId, next);
      retries.set(hostId, setTimeout(retry, retryMs));
    }
  }

  bb.implement(concurrencyLimit.get, view);
  bb.implement(concurrencyLimit.update, async (next) => {
    await save(next);
    return view();
  });

  bb.on(machines.connected, ({ hostId }) => {
    bb.changed(concurrencyLimit.get);
    void detect(hostId);
  });
  bb.on(machines.disconnected, () => bb.changed(concurrencyLimit.get));
  bb.onStart(() => {
    void bb.call(machines.list, {}).then((hosts) => {
      for (const host of hosts) {
        if (host.status === "connected") void detect(host.id);
      }
    });
  });
  for (const freed of [
    threads.idle,
    threads.failed,
    threads.archived,
    threads.deleted,
  ]) {
    bb.on(freed, () => void releaseWaiting());
  }

  async function defaultHost(projectId: string) {
    const { sources } = await bb.call(projects.get, { projectId });
    const source = sources.find((entry) => entry.isDefault) ?? sources[0];
    if (source === undefined) return null;
    const hosts = await bb.call(machines.list, {});
    return hosts.find((entry) => entry.id === source.hostId) ?? null;
  }

  bb.on(threads.hold, async ({ threadId }, next) => {
    const held = await next();
    if (held !== null) return held;
    const thread = await bb.call(threads.get, { threadId, include: "host" });
    if (RUNNING.has(thread.status)) return null;
    const host =
      ("host" in thread ? thread.host : null) ??
      (await defaultHost(thread.projectId));
    if (configuration.globalLimit === null && host === null) return null;
    const running = (await bb.call(threads.list, { includeHidden: true }))
      .filter((entry) => entry.id !== threadId)
      .filter((entry) => RUNNING.has(entry.status));
    const hold = (reason: string) => ({ pluginId: bb.pluginId, reason });
    const { globalLimit } = configuration;
    if (globalLimit !== null && running.length >= globalLimit) {
      return hold(waitReason(globalLimit, "all hosts"));
    }
    if (host === null) return null;
    const limit = hostLimit(host.id);
    const onHost = running.filter(
      (entry) => entry.environmentHostId === host.id,
    );
    if (onHost.length < limit) return null;
    const label = host.name.trim() === "" ? host.id : host.name;
    return hold(waitReason(limit, `host ${label}`));
  });

  async function requireHost(hostId: string): Promise<HostLimit> {
    const found = (await view()).hosts.find((host) => host.id === hostId);
    if (found !== undefined) return found;
    throw new PluginCliError(`Unknown host: ${hostId}`, {
      code: "unknown_host",
      hint: "Run `bb machine list` for the enrolled host ids.",
    });
  }

  const status = cliCommand({
    summary: "Show effective concurrency limits",
    description:
      "A limit holds new turns in line until a running thread goes idle. The automatic host limit is one thread per available processor.",
    options: { json: JSON_OPTION },
    async run({ options }) {
      const current = await view();
      const overall = current.globalLimit ?? "unlimited";
      const stdout = options.json
        ? JSON.stringify(current)
        : [
            `Overall: ${overall}`,
            "Automatic host limit: one thread per available processor",
            ...current.hosts.map(formatHost),
          ].join("\n");
      return { exitCode: 0, stdout };
    },
  });
  const global = cliCommand({
    summary: "Show or set the overall limit",
    positionals: [
      {
        name: "limit",
        description: `unlimited, or a whole number from 0 to ${MAX_LIMIT_VALUE} (0 holds every new turn); omit it to print the current limit`,
      },
    ],
    options: { json: JSON_OPTION },
    async run({ options, positionals }) {
      if (positionals.limit !== undefined) {
        const globalLimit = parseLimitArgument(positionals.limit, "unlimited");
        await save({ ...configuration, globalLimit });
      }
      const { globalLimit } = configuration;
      const stdout = options.json
        ? JSON.stringify({ globalLimit })
        : globalLimit === null
          ? "Unlimited"
          : String(globalLimit);
      return { exitCode: 0, stdout };
    },
  });
  const host = cliCommand({
    summary: "Show or set one host limit",
    positionals: [
      {
        name: "host-id",
        description: "Enrolled host id, as `bb machine list` prints it",
        required: true,
      },
      {
        name: "limit",
        description: `auto, or a whole number from 0 to ${MAX_LIMIT_VALUE} (0 holds every new turn on that host); omit it to print the host's limit`,
      },
    ],
    options: { json: JSON_OPTION },
    async run({ options, positionals }) {
      const hostId = positionals["host-id"];
      await requireHost(hostId);
      if (positionals.limit !== undefined) {
        const limit = parseLimitArgument(positionals.limit, "auto");
        const hostOverrides = configuration.hostOverrides.filter(
          (entry) => entry.hostId !== hostId,
        );
        if (limit !== null) hostOverrides.push({ hostId, limit });
        await save({ ...configuration, hostOverrides });
      }
      const updated = await requireHost(hostId);
      const stdout = options.json
        ? JSON.stringify(updated)
        : formatHost(updated);
      return { exitCode: 0, stdout };
    },
  });
  bb.cli.register(
    defineCli({
      name: "concurrency-limit",
      summary: "Configure global and per-host thread limits",
      commands: { status, global, host },
    }),
  );
}
