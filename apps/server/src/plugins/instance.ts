import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type * as plugin from "@bb/plugin";
import Database from "better-sqlite3";
import type { Logger } from "../context.js";
import type { Db } from "../db/index.js";
import { readPluginRows, writePluginRow } from "../db/plugins.js";
import { errorMessage } from "../http/errors.js";
import type { Hub } from "../ws/hub.js";
import type { PluginHostDeps } from "./deps.js";
import { PluginSettings, type SettingRecord } from "./settings.js";

type MaybePromise<T> = T | Promise<T>;
type Contributor<T> = (context: plugin.ThreadContext) => MaybePromise<T>;
type EventHandler = (
  payload: plugin.PluginEvents[keyof plugin.PluginEvents],
) => unknown;
type RpcHandler = (input: unknown) => unknown;
type Service = Parameters<plugin.PluginServerApi["background"]["service"]>;

export interface PluginApiHost {
  db: Db;
  hub: Hub;
  log: Logger;
  dataDir: string;
  serverUrl: string;
  tunnelToken: string;
  deps: PluginHostDeps;
}

const KV_VALUE_MAX_BYTES = 256 * 1024;
const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS _bb_migrations
  (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, statement_hash TEXT)`;
const SERVICE_RESTART_BASE_MS = 1_000;
const SERVICE_HEALTHY_MS = 60_000;

export class PluginInstance {
  readonly rpc = new Map<
    string,
    { contract: plugin.RpcMethodContract; handler: RpcHandler }
  >();
  readonly routes = new Map<
    string,
    { handler: plugin.HttpHandler; auth: plugin.HttpAuth }
  >();
  cli: plugin.CliRegistration | null = null;
  readonly tools: plugin.AgentTool[] = [];
  readonly instructions: Contributor<string | null>[] = [];
  readonly env: [providerId: string, Contributor<plugin.ProviderEnvEntry[]>][] =
    [];
  readonly mentionProviders: plugin.MentionProvider[] = [];
  readonly environments: plugin.EnvironmentDefinition[] = [];
  readonly inference: plugin.InferenceService[] = [];
  readonly listeners: [name: string, handler: EventHandler][] = [];
  readonly services: Service[] = [];
  readonly disposers: (() => unknown)[] = [];
  readonly stopping = new AbortController();
  needsConfiguration: string | null = null;
  publicUrl: string | null = null;
  machineAccess: plugin.MachineAccessProvider | null = null;

  constructor(
    readonly settings: PluginSettings,
    readonly log: plugin.PluginServerApi["log"],
  ) {}

  startServices(): void {
    for (const service of this.services) void this.supervise(service);
  }

  async dispose(): Promise<void> {
    this.stopping.abort();
    for (const dispose of this.disposers.reverse()) {
      try {
        await dispose();
      } catch (error) {
        this.log.warn(`dispose hook failed: ${errorMessage(error)}`);
      }
    }
  }

  private async supervise([name, service]: Service): Promise<void> {
    const { signal } = this.stopping;
    for (let crashes = 0; !signal.aborted; crashes += 1) {
      const startedAt = Date.now();
      try {
        await service.start(signal);
        return;
      } catch (error) {
        if (signal.aborted) return;
        if (Date.now() - startedAt >= SERVICE_HEALTHY_MS) crashes = 0;
        const delay = SERVICE_RESTART_BASE_MS * 2 ** Math.min(crashes, 6);
        const reason = errorMessage(error);
        this.log.warn(`service ${name} crashed, restarting: ${reason}`);
        await sleep(delay, undefined, { signal }).catch(() => {});
      }
    }
  }
}

function collect<T>(list: T[]): (item: T) => void {
  return (item) => {
    list.push(item);
  };
}

function migrate(database: Database.Database, statements: string[]) {
  database.exec(MIGRATIONS_TABLE);
  const applied = database
    .prepare<[], { statement_hash: string | null }>(
      "SELECT statement_hash FROM _bb_migrations ORDER BY id",
    )
    .all();
  const record = database.prepare(
    "INSERT INTO _bb_migrations VALUES (?, ?, ?)",
  );
  database.transaction(() => {
    statements.forEach((statement, index) => {
      const hash = createHash("sha256").update(statement).digest("hex");
      const recorded = applied[index];
      if (recorded === undefined) {
        database.exec(statement);
        record.run(index, Date.now(), hash);
      } else if ((recorded.statement_hash ?? hash) !== hash) {
        throw new Error(
          `Migration ${index} changed after it was applied; append a new one`,
        );
      }
    });
  })();
}

export function createPluginInstance(
  host: PluginApiHost,
  pluginId: string,
): { instance: PluginInstance; api: plugin.PluginServerApi } {
  const { db, hub } = host;
  const dataDir = join(host.dataDir, "plugins", pluginId);
  mkdirSync(dataDir, { recursive: true });
  const at = (level: keyof Logger) => (message: string) =>
    host.log[level](message, { pluginId });
  const log = {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
  const settings = new PluginSettings(db, pluginId, join(dataDir, "secrets"));
  const instance = new PluginInstance(settings, log);
  const { requestInput, ...outward } = host.deps(pluginId);
  let database: Database.Database | undefined;

  const api: plugin.PluginServerApi = {
    ...outward,
    pluginId,
    log,
    dataDir,
    settings: {
      define<D extends plugin.SettingDescriptors>(descriptors: D) {
        settings.define(descriptors);
        const typed = (values: SettingRecord) =>
          values as plugin.SettingValues<D>;
        const handle: plugin.SettingsHandle<D> = {
          get: async () => typed(await settings.read()),
          set: async (values) => typed(await settings.write(values)),
          onChange: (listener) => {
            settings.listeners.push((next, previous) => {
              try {
                listener(typed(next), typed(previous));
              } catch (error) {
                log.warn(`settings listener failed: ${errorMessage(error)}`);
              }
            });
          },
        };
        return handle;
      },
    },
    storage: {
      kv: {
        async get<T>(key: string) {
          const text = readPluginRows(db, "plugin_kv", pluginId, key).get(key);
          return text === undefined ? undefined : (JSON.parse(text) as T);
        },
        async set(key, value) {
          const text = JSON.stringify(value);
          if (text === undefined || text.length > KV_VALUE_MAX_BYTES) {
            throw new Error(`KV value for "${key}" is not JSON under 256 KiB`);
          }
          writePluginRow(db, "plugin_kv", pluginId, key, text);
        },
        async delete(key) {
          writePluginRow(db, "plugin_kv", pluginId, key, null);
        },
        async list(prefix) {
          return [...readPluginRows(db, "plugin_kv", pluginId, prefix).keys()];
        },
      },
      database() {
        if (database?.open) return database;
        const opened = new Database(join(dataDir, "data.db"));
        opened.pragma("journal_mode = WAL");
        opened.pragma("busy_timeout = 5000");
        instance.disposers.unshift(() => opened.close());
        database = opened;
        return opened;
      },
      migrate,
    },
    rpc: {
      register(contract, handlers) {
        for (const [method, methodContract] of Object.entries(contract)) {
          const handler = handlers[method] as RpcHandler;
          instance.rpc.set(method, { contract: methodContract, handler });
        }
      },
    },
    http: {
      route(method, path, handler, { auth = "local" } = {}) {
        const key = `${method.toUpperCase()} ${path}`;
        instance.routes.set(key, { handler, auth });
      },
    },
    realtime: { publish: hub.pluginSignal.bind(hub, pluginId) },
    background: {
      service: (...service) => {
        instance.services.push(service);
      },
    },
    cli: {
      register(registration) {
        if (instance.cli !== null) throw new Error("A plugin has one CLI");
        instance.cli = registration;
      },
    },
    events: {
      on: (name, handler) => {
        instance.listeners.push([name, handler as EventHandler]);
      },
    },
    agents: {
      registerTool: collect(instance.tools),
      contributeInstructions: collect(instance.instructions),
    },
    ui: {
      requestInput,
      registerMentionProvider: collect(instance.mentionProviders),
    },
    providers: {
      contributeEnv: (providerId, contribute) => {
        instance.env.push([providerId, contribute]);
      },
    },
    environments: { register: collect(instance.environments) },
    inference: { register: collect(instance.inference) },
    status: {
      needsConfiguration(message) {
        instance.needsConfiguration = message;
        hub.system(["plugins-changed"]);
      },
    },
    machines: {
      setAccessProvider: (provider) => {
        instance.machineAccess = provider;
      },
    },
    server: {
      url: host.serverUrl,
      dataDir: host.dataDir,
      tunnelToken: host.tunnelToken,
      setPublicUrl: (url) => {
        instance.publicUrl = url;
      },
    },
    onDispose: collect(instance.disposers),
  };
  return { instance, api };
}
