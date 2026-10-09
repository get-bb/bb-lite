import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Kernel, Tier } from "@bb/plugin";
import type * as plugin from "@bb/plugin";
import Database from "better-sqlite3";
import type { Logger } from "@bb/server-kit/context";
import type { Db } from "@bb/server-kit/db/index";
import { readPluginRows, writePluginRow } from "@bb/server-kit/db/plugins";
import { errorMessage } from "@bb/server-kit/http/errors";
import { asPlugin, currentCaller } from "@bb/server-kit/kernel/caller";
import type { Hub } from "@bb/server-kit/ws/hub";
import { cronMatches, parseCron, type Cron } from "./cron.js";
import { PluginSettings, type SettingRecord } from "./settings.js";
import { createPluginTables } from "./tables.js";

type Service = Parameters<plugin.PluginServerApi["background"]["service"]>;
type Starter = Parameters<plugin.PluginServerApi["onStart"]>[0];

export interface PluginApiHost {
  db: Db;
  hub: Hub;
  log: Logger;
  kernel: Kernel;
  server: plugin.ServerInfo;
  runners: plugin.Runners;
  now(): number;
  routes(routes: plugin.ApiRoutes, internal: boolean): () => void;
  sockets(resolver: plugin.SocketResolver): () => void;
}

const KV_VALUE_MAX_BYTES = 256 * 1024;
const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS _bb_migrations
  (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, statement_hash TEXT)`;
const SERVICE_RESTART_BASE_MS = 1_000;
const SERVICE_HEALTHY_MS = 60_000;

export class PluginInstance {
  readonly routes = new Map<
    string,
    { handler: plugin.HttpHandler; auth: plugin.HttpAuth }
  >();
  cli: plugin.CliRegistration | null = null;
  readonly services: Service[] = [];
  readonly starters: Starter[] = [];
  readonly disposers: (() => unknown)[] = [];
  readonly stopping = new AbortController();
  needsConfiguration: string | null = null;

  constructor(
    readonly settings: PluginSettings,
    readonly log: plugin.PluginServerApi["log"],
  ) {}

  async start(): Promise<void> {
    for (const start of this.starters) {
      const stop = await start();
      if (typeof stop === "function") this.disposers.push(stop);
    }
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

const MINUTE_MS = 60_000;

function scheduled(cron: Cron, run: (signal: AbortSignal) => unknown) {
  return async (signal: AbortSignal): Promise<void> => {
    while (!signal.aborted) {
      const untilNextMinute = MINUTE_MS - (Date.now() % MINUTE_MS);
      await sleep(untilNextMinute, undefined, { signal }).catch(() => {});
      if (signal.aborted) return;
      if (cronMatches(cron, new Date())) await run(signal);
    }
  };
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

function runnersFor(runners: plugin.Runners, pluginId: string): plugin.Runners {
  const acting = <Args extends unknown[], Result>(
    run: (...args: Args) => Result,
  ) => {
    return (...args: Args) => asPlugin(pluginId, () => run(...args));
  };
  return new Proxy(runners, {
    get(target, key) {
      if (key === "call") return acting(target.call.bind(target));
      if (key !== "get") {
        const member: unknown = Reflect.get(target, key, target);
        return typeof member === "function" ? member.bind(target) : member;
      }
      return (hostId: string) => {
        const runner = target.get(hostId);
        return new Proxy(runner, {
          get: (machine, name, receiver) =>
            name === "call"
              ? acting(machine.call.bind(machine))
              : (Reflect.get(machine, name, receiver) as unknown),
        });
      };
    },
  });
}

export function createPluginInstance(
  host: PluginApiHost,
  pluginId: string,
  tier: Tier,
): { instance: PluginInstance; api: plugin.PluginServerApi } {
  const { db, hub } = host;
  const dataDir = join(host.server.dataDir, "plugins", pluginId);
  mkdirSync(dataDir, { recursive: true });
  const at =
    (level: keyof Logger) => (message: string, fields?: plugin.LogFields) =>
      host.log[level](message, { pluginId, ...fields });
  const log = {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
  const settings = new PluginSettings(db, pluginId, join(dataDir, "secrets"));
  const instance = new PluginInstance(settings, log);
  const { dispose: release, ...verbs } = host.kernel.scope(pluginId, tier);
  instance.disposers.push(release);
  let database: Database.Database | undefined;

  const api: plugin.PluginServerApi = {
    ...verbs,
    pluginId,
    log,
    dataDir,
    server: host.server,
    db,
    realtime: hub,
    runners: runnersFor(host.runners, pluginId),
    now: host.now,
    settings: {
      define<D extends plugin.SettingDescriptors>(
        descriptors: D,
        { scope = "workspace" }: { scope?: plugin.SettingScope } = {},
      ) {
        settings.define(descriptors, scope);
        const user = () => currentCaller().user;
        const typed = (values: SettingRecord) =>
          values as plugin.SettingValues<D>;
        const handle: plugin.SettingsHandle<D> = {
          get: async () => typed(await settings.read(user())),
          set: async (values) => typed(await settings.write(values, user())),
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
      database(migrations) {
        if (database?.open) return database;
        const opened = new Database(join(dataDir, "data.db"));
        opened.pragma("journal_mode = WAL");
        opened.pragma("busy_timeout = 5000");
        instance.disposers.unshift(() => opened.close());
        if (migrations !== undefined) migrate(opened, migrations);
        database = opened;
        return opened;
      },
      tables: createPluginTables(db, pluginId, verbs),
    },
    http: {
      route(method, path, handler, { auth = "local" } = {}) {
        const key = `${method.toUpperCase()} ${path}`;
        instance.routes.set(key, { handler, auth });
      },
      api(routes, { internal = false } = {}) {
        instance.disposers.push(host.routes(routes, internal));
      },
      socket(resolver) {
        instance.disposers.push(host.sockets(resolver));
      },
    },
    background: {
      service: (...service) => {
        instance.services.push(service);
      },
      schedule(name, expression, run) {
        const cron = parseCron(expression);
        instance.services.push([name, { start: scheduled(cron, run) }]);
      },
    },
    cli: {
      register(registration) {
        if (instance.cli !== null) throw new Error("A plugin has one CLI");
        instance.cli = registration;
      },
    },
    status: {
      needsConfiguration(message) {
        instance.needsConfiguration = message;
        hub.system(["plugins-changed"]);
      },
    },
    onStart: collect(instance.starters),
    onDispose: collect(instance.disposers),
  };
  return { instance, api };
}
