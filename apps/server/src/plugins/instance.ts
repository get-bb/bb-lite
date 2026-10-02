import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  AgentTool,
  CliRegistration,
  EnvironmentDefinition,
  HttpAuth,
  HttpHandler,
  InferenceService,
  MentionProvider,
  PluginEvents,
  PluginServerApi,
  ProviderEnvEntry,
  RpcMethodContract,
  SettingDescriptors,
  SettingsHandle,
  SettingValues,
  ThreadContext,
} from "@bb/plugin";
import Database from "better-sqlite3";
import type { Logger } from "../context.js";
import type { Db } from "../db/index.js";
import { readPluginRows, writePluginRow } from "../db/plugins.js";
import type { Hub } from "../ws/hub.js";
import type { PluginHostDeps } from "./deps.js";
import { PluginSettings, type SettingRecord } from "./settings.js";

type MaybePromise<T> = T | Promise<T>;
type Contributor<T> = (context: ThreadContext) => MaybePromise<T>;
type EventHandler = (payload: PluginEvents[keyof PluginEvents]) => unknown;
type RpcHandler = (input: unknown) => unknown;
type Service = Parameters<PluginServerApi["background"]["service"]>;

export interface PluginApiHost {
  db: Db;
  hub: Hub;
  log: Logger;
  dataDir: string;
  serverUrl: string;
  deps: PluginHostDeps;
}

const KV_VALUE_MAX_BYTES = 256 * 1024;
const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS _bb_migrations
  (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, statement_hash TEXT)`;
const SERVICE_RESTART_BASE_MS = 1_000;
const SERVICE_HEALTHY_MS = 60_000;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PluginInstance {
  readonly rpc = new Map<
    string,
    { contract: RpcMethodContract; handler: RpcHandler }
  >();
  readonly routes = new Map<string, { handler: HttpHandler; auth: HttpAuth }>();
  cli: CliRegistration | null = null;
  readonly tools: AgentTool[] = [];
  readonly instructions: Contributor<string | null>[] = [];
  readonly env: [providerId: string, Contributor<ProviderEnvEntry[]>][] = [];
  readonly mentionProviders: MentionProvider[] = [];
  readonly environments: EnvironmentDefinition[] = [];
  readonly inference: InferenceService[] = [];
  readonly listeners: [name: string, handler: EventHandler][] = [];
  readonly services: Service[] = [];
  readonly disposers: (() => unknown)[] = [];
  readonly stopping = new AbortController();
  needsConfiguration: string | null = null;

  constructor(
    readonly settings: PluginSettings,
    readonly log: PluginServerApi["log"],
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

function migrate(database: Database.Database, statements: string[]): void {
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
): { instance: PluginInstance; api: PluginServerApi } {
  const { db, hub } = host;
  const dataDir = join(host.dataDir, "plugins", pluginId);
  mkdirSync(dataDir, { recursive: true });
  const at =
    (level: keyof Logger) =>
    (message: string): void =>
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

  const api: PluginServerApi = {
    ...outward,
    pluginId,
    log,
    dataDir,
    settings: {
      define<D extends SettingDescriptors>(descriptors: D) {
        settings.define(descriptors);
        const typed = (values: SettingRecord) => values as SettingValues<D>;
        const handle: SettingsHandle<D> = {
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
    server: { url: host.serverUrl, dataDir: host.dataDir },
    onDispose: collect(instance.disposers),
  };
  return { instance, api };
}
