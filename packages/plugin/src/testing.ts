import type Database from "better-sqlite3";
import type { z } from "zod";
import type { CliRegistration } from "./cli.js";
import type { Op } from "./contract.js";
import {
  createKernel,
  type AuditRecord,
  type Caller,
  type Implementation,
  type Kernel,
  type Tier,
} from "./kernel.js";
import type {
  HttpAuth,
  HttpHandler,
  PluginServerApi,
  PluginServerEntry,
  PluginTables,
  SettingDescriptors,
  SettingValue,
} from "./server-api.js";

type MaybePromise<T> = T | Promise<T>;
type Service = { start(signal: AbortSignal): MaybePromise<void> };

export interface LoadOptions {
  tier?: Tier;
  settings?: Record<string, SettingValue>;
  database?: () => Database.Database;
  tables?: PluginTables;
}

const noTables = (): never => {
  throw new Error("Pass `tables` to load() to use shared tables");
};
const unavailableTables: PluginTables = {
  name: noTables,
  migrate: noTables,
  publish: noTables,
  of: noTables,
  all: noTables,
  get: noTables,
  run: noTables,
};

export interface LoadedPlugin {
  api: PluginServerApi;
  cli: CliRegistration | null;
  routes: Map<string, { handler: HttpHandler; auth: HttpAuth }>;
  services: Map<string, Service>;
  kv: Map<string, unknown>;
  settings: Map<string, SettingValue>;
  logs: string[];
  needsConfiguration: string | null;
  unload(): Promise<void>;
}

export interface PluginHarness {
  kernel: Kernel;
  records: AuditRecord[];
  changes: string[];
  warnings: string[];
  as<T>(caller: Partial<Caller>, work: () => T): T;
  stub<O extends Op>(
    op: O,
    run: Implementation<z.output<O["input"]>, z.input<O["output"]>>,
  ): void;
  load(
    pluginId: string,
    entry: PluginServerEntry,
    options?: LoadOptions,
  ): Promise<LoadedPlugin>;
}

const OWNER: Caller = {
  user: "usr_owner",
  role: "owner",
  door: "app",
  thread: null,
  via: [],
};

export function createPluginHarness(): PluginHarness {
  let caller = OWNER;
  const records: AuditRecord[] = [];
  const changes: string[] = [];
  const warnings: string[] = [];
  const enter = <T>(next: Caller, work: () => T): T => {
    const previous = caller;
    caller = next;
    const restore = () => {
      caller = previous;
    };
    let result: T;
    try {
      result = work();
    } catch (error) {
      restore();
      throw error;
    }
    if (result instanceof Promise) {
      return result.finally(restore) as T;
    }
    restore();
    return result;
  };
  const kernel = createKernel({
    currentCaller: () => caller,
    enter,
    record: (entry) => records.push(entry),
    now: Date.now,
    warn: (message, fields) =>
      warnings.push(`${message} ${JSON.stringify(fields)}`),
    changed: (name) => changes.push(name),
  });
  const stubs = kernel.scope("test", "product");

  return {
    kernel,
    records,
    changes,
    warnings,
    as: (given, work) => enter({ ...OWNER, ...given }, work),
    stub: (op, run) => stubs.implement(op, run),
    async load(pluginId, entry, options = {}) {
      const { dispose, ...verbs } = kernel.scope(
        pluginId,
        options.tier ?? "installed",
      );
      const disposers: (() => MaybePromise<void>)[] = [dispose];
      const kv = new Map<string, unknown>();
      const settings = new Map(Object.entries(options.settings ?? {}));
      const logs: string[] = [];
      const routes: LoadedPlugin["routes"] = new Map();
      const services: LoadedPlugin["services"] = new Map();
      const starters: Parameters<PluginServerApi["onStart"]>[0][] = [];
      let descriptors: SettingDescriptors = {};
      const listeners: ((next: object, previous: object) => void)[] = [];
      const values = () =>
        Object.fromEntries(
          Object.entries(descriptors).map(([key, descriptor]) => {
            return [key, settings.get(key) ?? descriptor.default];
          }),
        );
      const at = (level: string) => (message: string) => {
        logs.push(`${level}: ${message}`);
      };
      const loaded: LoadedPlugin = {
        api: undefined as never,
        cli: null,
        routes,
        services,
        kv,
        settings,
        logs,
        needsConfiguration: null,
        async unload() {
          for (const stop of disposers.reverse()) await stop();
          disposers.length = 0;
        },
      };
      const api: PluginServerApi = {
        ...verbs,
        pluginId,
        log: {
          debug: at("debug"),
          info: at("info"),
          warn: at("warn"),
          error: at("error"),
        },
        dataDir: `/tmp/bb-test/${pluginId}`,
        settings: {
          define(defined) {
            descriptors = { ...descriptors, ...defined };
            return {
              get: async () => values() as never,
              async set(update) {
                const previous = values();
                for (const [key, value] of Object.entries(update)) {
                  if (value === null || value === undefined) {
                    settings.delete(key);
                  } else settings.set(key, value as SettingValue);
                }
                const next = values();
                for (const listener of listeners) listener(next, previous);
                return next as never;
              },
              onChange(listener) {
                listeners.push(listener as (typeof listeners)[number]);
              },
            };
          },
        },
        storage: {
          kv: {
            get: async (key) => kv.get(key) as never,
            set: async (key, value) => void kv.set(key, value),
            delete: async (key) => void kv.delete(key),
            list: async (prefix = "") =>
              [...kv.keys()].filter((key) => key.startsWith(prefix)).sort(),
          },
          database() {
            if (options.database !== undefined) return options.database();
            throw new Error("Pass `database` to load() to use a database");
          },
          migrate(database, statements) {
            for (const statement of statements) database.exec(statement);
          },
          tables: options.tables ?? unavailableTables,
        },
        http: {
          route(method, path, handler, { auth = "local" } = {}) {
            routes.set(`${method.toUpperCase()} ${path}`, { handler, auth });
          },
        },
        background: {
          service: (name, service) => void services.set(name, service),
        },
        cli: {
          register(registration) {
            loaded.cli = registration;
          },
        },
        machine: () => ({
          call: (op, input) => kernel.call(op, input),
        }),
        status: {
          needsConfiguration(message) {
            loaded.needsConfiguration = message;
          },
        },
        server: {
          url: "http://127.0.0.1:0",
          dataDir: "/tmp/bb-test",
          tunnelToken: "test",
        },
        onStart: (start) => void starters.push(start),
        onDispose: (stop) => void disposers.push(stop),
      };
      loaded.api = api;
      try {
        await entry(api);
        for (const start of starters) {
          const stop = await start();
          if (typeof stop === "function") disposers.push(stop);
        }
      } catch (error) {
        await loaded.unload();
        throw error;
      }
      return loaded;
    },
  };
}
